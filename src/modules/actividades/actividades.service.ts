// src/modules/actividades/actividades.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { siguienteCodigo } from '../../common/consecutivos/codigo-consecutivo';
import { CorreoService } from '../../common/correo/correo.service';
import { EnlaceAccesoService } from '../../common/cuentas/enlace-acceso.service';
import {
  DirectorioService,
  type Destinatario,
} from '../../common/directorio/directorio.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  ejecutarAlArrancar,
  ejecutarTareaProgramada,
} from '../../common/programacion/tarea-programada';
import { LockService } from '../../common/redis/lock.service';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { Actividad as ActividadContrato } from '../../contracts';
import {
  Actividad,
  type ActividadDocument,
  type EstadoActividad,
} from '../../database/schemas/administracion/actividad.schema';
import {
  ConsecutivoAdministracion,
  type ConsecutivoAdministracionDocument,
} from '../../database/schemas/administracion/consecutivo-administracion.schema';
import {
  Copropiedad,
  type CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import { NotificacionesService } from '../notificaciones/notificaciones.service';
import { construirCorreoActividadNueva } from './actividad-correo';

/** States in which residents may still sign up or out; the rest are history. */
const ESTADOS_CON_ASISTENCIA: EstadoActividad[] = ['proximo', 'en_curso'];
import {
  desdeActualizarDto,
  desdeCrearDto,
  toActividad,
} from './actividades.mapper';
import type { ActualizarActividadDto } from './dto/actualizar-actividad.dto';
import type { CrearActividadDto } from './dto/guardar-actividad.dto';
import type { ListarActividadesDto } from './dto/listar-actividades.dto';

/**
 * How many residents are emailed at once. The host only has CPU while a request
 * is open, so the notices are awaited inside it; this bounds the burst against
 * the mail provider and Mongo instead of firing hundreds of sends together.
 */
export const ENVIOS_SIMULTANEOS = 10;

/** Result of signing up for / leaving an activity. */
export interface ResultadoAsistencia {
  asistiendo: boolean;
  asistentes: number;
}

/**
 * Community activities of the ACTIVE coproperty. The tenant always comes from
 * the request context; every lookup and write filters by id AND
 * `copropiedadId`, so an activity id of another building is a plain 404.
 *
 * Staff manage activities (`ActividadesController`); residents list them and
 * sign up (`ActividadesPortalController`). Both use this service.
 */
@Injectable()
export class ActividadesService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ActividadesService.name);

  constructor(
    @InjectModel(Actividad.name)
    private readonly actividades: Model<ActividadDocument>,
    @InjectModel(ConsecutivoAdministracion.name)
    private readonly consecutivos: Model<ConsecutivoAdministracionDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    private readonly tenant: TenantContextService,
    private readonly lock: LockService,
    private readonly directorio: DirectorioService,
    private readonly correo: CorreoService,
    private readonly enlaces: EnlaceAccesoService,
    private readonly notificaciones: NotificacionesService,
  ) {}

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    }
  }

  /**
   * Best-effort: one resident's email (with a sign-in button when an access link
   * may be issued) plus their in-app entry. Never throws, so one bad recipient
   * cannot stop the others; a null link still sends the email, just without the
   * button.
   */
  private async notificarResidente(
    residente: Destinatario,
    actividad: ActividadDocument,
    copropiedadId: Types.ObjectId,
    nombreCopropiedad: string,
  ): Promise<void> {
    try {
      const enlace = await this.enlaces.construir(
        residente.accountId,
        copropiedadId.toString(),
        `/portal/actividades?abrir=${actividad._id.toString()}`,
      );
      const { asunto, html } = construirCorreoActividadNueva({
        nombreResidente: residente.nombre,
        nombreCopropiedad,
        titulo: actividad.titulo,
        categoria: actividad.categoria,
        fecha: actividad.fecha,
        horario: actividad.horario,
        ubicacion: actividad.ubicacion,
        descripcion: actividad.descripcion || undefined,
        enlace,
      });

      const enviado = await this.correo.enviar({
        para: residente.email,
        asunto,
        html,
      });
      if (!enviado) {
        this.logger.error(
          `No se pudo notificar la actividad ${actividad._id.toString()} a ${residente.email}.`,
        );
      }
      await this.notificaciones.crear({
        copropiedadId,
        accountId: residente.accountId,
        tipo: 'actividad',
        titulo: asunto,
      });
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la actividad ${actividad._id.toString()} a ${residente.email}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Best-effort: announces a new activity to every resident of the coproperty
   * that has an account, in batches of at most `ENVIOS_SIMULTANEOS`. Never
   * throws: the activity already exists, a mail outage must not undo it.
   */
  private async notificarNuevaActividad(
    actividad: ActividadDocument,
    copropiedadId: Types.ObjectId,
  ): Promise<void> {
    try {
      const residentes = await this.directorio.residentes(copropiedadId);
      if (residentes.length === 0) return;

      // `findById` is allowed here: the id IS the tenant.
      const copropiedad = await this.copropiedades
        .findById(copropiedadId)
        .select('nombre')
        .exec();
      const nombreCopropiedad = copropiedad?.nombre ?? '';

      for (let i = 0; i < residentes.length; i += ENVIOS_SIMULTANEOS) {
        await Promise.all(
          residentes
            .slice(i, i + ENVIOS_SIMULTANEOS)
            .map((residente) =>
              this.notificarResidente(
                residente,
                actividad,
                copropiedadId,
                nombreCopropiedad,
              ),
            ),
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo notificar la nueva actividad ${actividad._id.toString()}: ${(error as Error).message}`,
      );
    }
  }

  /** Creates an activity in the active coproperty and announces it to residents. */
  async crear(dto: CrearActividadDto): Promise<ActividadContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const codigo = await siguienteCodigo(this.consecutivos, 'ACT');
    const creada = await new this.actividades({
      ...desdeCrearDto(dto, copropiedadId),
      codigo,
    }).save();
    await this.notificarNuevaActividad(creada, copropiedadId);
    return toActividad(creada);
  }

  /** The active coproperty's activities, newest date first, optionally filtered. */
  private async consultar(
    filtros: ListarActividadesDto,
  ): Promise<ActividadDocument[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };
    if (filtros.categoria && filtros.categoria !== 'todos') {
      filtro.categoria = filtros.categoria;
    }
    if (filtros.estado && filtros.estado !== 'todos') {
      filtro.estado = filtros.estado;
    }
    return this.actividades.find(filtro).sort({ fecha: -1 }).exec();
  }

  /** Staff list: no per-caller `asistiendo`, it is a resident-side notion. */
  async listar(filtros: ListarActividadesDto): Promise<ActividadContrato[]> {
    const documentos = await this.consultar(filtros);
    return documentos.map((documento) => toActividad(documento));
  }

  /**
   * Resident list: the same rows with `asistiendo` set for the caller. A caller
   * with no account id is never "attending" anything (fail closed to false).
   */
  async listarParaResidente(
    filtros: ListarActividadesDto,
    user: IRequestUser,
  ): Promise<ActividadContrato[]> {
    const documentos = await this.consultar(filtros);
    const cuentaId = user.accountId ?? '';
    return documentos.map((documento) => toActividad(documento, cuentaId));
  }

  /** Edits an activity of the active coproperty and returns the contract. */
  async actualizar(
    id: string,
    dto: ActualizarActividadDto,
  ): Promise<ActividadContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.actividades
      .findOneAndUpdate(
        { _id: id, copropiedadId },
        { $set: desdeActualizarDto(dto) },
        { new: true },
      )
      .exec();
    if (!documento)
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    return toActividad(documento);
  }

  /** Deletes an activity of the active coproperty; 404 when there is none. */
  async eliminar(id: string): Promise<{ id: string }> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.actividades
      .findOneAndDelete({ _id: id, copropiedadId })
      .exec();
    if (!documento)
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    return { id };
  }

  /** The resident's account id, or a 400 when the session has none usable. */
  private cuentaParaAsistir(user: IRequestUser): Types.ObjectId {
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new BadRequestException('Usuario no tiene cuenta asociada');
    }
    return new Types.ObjectId(user.accountId);
  }

  /**
   * Why a join/leave did not apply, read AFTER the atomic write missed:
   * missing (404), closed (409, attendance of a finished or cancelled activity
   * is history), or null when the caller simply is already in the wanted state.
   */
  private async explicarFallo(
    id: string,
    copropiedadId: Types.ObjectId,
  ): Promise<ActividadDocument> {
    const existente = await this.actividades
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!existente)
      throw new NotFoundException(`Actividad ${id} no encontrada`);
    if (!ESTADOS_CON_ASISTENCIA.includes(existente.estado)) {
      throw new ConflictException(
        'La actividad ya terminó o fue cancelada: no admite cambios de asistencia',
      );
    }
    return existente;
  }

  /**
   * Signs the resident up. Explicit and idempotent (a double click never signs
   * them out, unlike the toggle of the system this replaces), only for an
   * activity still open (`proximo`/`en_curso`). The capacity check lives INSIDE
   * the update filter, so Mongo decides it per document and the list can never
   * exceed `capacidad` (0 = nobody can register).
   */
  async asistir(id: string, user: IRequestUser): Promise<ResultadoAsistencia> {
    const cuentaId = this.cuentaParaAsistir(user);
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const entro = await this.actividades
      .findOneAndUpdate(
        {
          _id: id,
          copropiedadId,
          estado: { $in: ESTADOS_CON_ASISTENCIA },
          participantesIds: { $ne: cuentaId },
          $expr: { $lt: [{ $size: '$participantesIds' }, '$capacidad'] },
        },
        { $addToSet: { participantesIds: cuentaId } },
        { new: true },
      )
      .exec();
    if (entro) {
      return { asistiendo: true, asistentes: entro.participantesIds.length };
    }

    const existente = await this.explicarFallo(id, copropiedadId);
    if (existente.participantesIds.some((p) => p.equals(cuentaId))) {
      return {
        asistiendo: true,
        asistentes: existente.participantesIds.length,
      };
    }
    throw new BadRequestException(
      'La actividad ya alcanzó su capacidad máxima',
    );
  }

  /** Signs the resident out; idempotent, only while the activity is open. */
  async dejarDeAsistir(
    id: string,
    user: IRequestUser,
  ): Promise<ResultadoAsistencia> {
    const cuentaId = this.cuentaParaAsistir(user);
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();

    const salio = await this.actividades
      .findOneAndUpdate(
        { _id: id, copropiedadId, estado: { $in: ESTADOS_CON_ASISTENCIA } },
        { $pull: { participantesIds: cuentaId } },
        { new: true },
      )
      .exec();
    if (salio) {
      return { asistiendo: false, asistentes: salio.participantesIds.length };
    }
    await this.explicarFallo(id, copropiedadId);
    // Unreachable in practice (open + existing would have matched).
    throw new NotFoundException(`Actividad ${id} no encontrada`);
  }

  /**
   * Marks as `finalizado` every `proximo`/`en_curso` activity dated before
   * today. Runs daily at midnight on every replica; the lock makes exactly one
   * execute it, and `ejecutarTareaProgramada` keeps a failure from becoming an
   * unhandled rejection in the scheduler.
   *
   * It spans ALL coproperties on purpose: it is housekeeping with no request
   * and no tenant, and the tenancy law governs request-scoped reads.
   *
   * Timezone caveat, kept from the original: "today" is the SERVER's local
   * midnight (`setHours`), and Cloud Run runs in UTC. So the cut-off is 19:00
   * the previous day in Bogotá, and an evening activity can be closed while it
   * is still happening. Fixing it means choosing a product timezone for the
   * cut-off, not changing this line in a port.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async finalizarPasadas(): Promise<void> {
    await ejecutarTareaProgramada(
      this.lock,
      this.logger,
      { clave: 'cron:actividades:finalizar-pasadas', ttlMs: 600_000 },
      async () => {
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);

        const resultado = await this.actividades
          .updateMany(
            { estado: { $in: ['proximo', 'en_curso'] }, fecha: { $lt: hoy } },
            { estado: 'finalizado' },
          )
          .exec();

        this.logger.log(
          `Actividades pasadas finalizadas: ${resultado.modifiedCount}`,
        );
      },
    );
  }

  /**
   * Cloud Run scales to zero, so the midnight cron only fires if an instance
   * happens to be awake: catch up once the process is up.
   */
  onApplicationBootstrap(): void {
    ejecutarAlArrancar(this.logger, 'finalización de actividades pasadas', () =>
      this.finalizarPasadas(),
    );
  }
}

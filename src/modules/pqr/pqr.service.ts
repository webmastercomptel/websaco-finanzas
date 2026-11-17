import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { siguienteCodigo } from '../../common/consecutivos/codigo-consecutivo';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { diaBogota } from '../../common/utils/dias-habiles';
import type {
  Pqr as PqrContrato,
  PqrPortal,
  Tarea as TareaContrato,
  TareaDePqr,
} from '../../contracts';
import {
  ConsecutivoAdministracion,
  type ConsecutivoAdministracionDocument,
} from '../../database/schemas/administracion/consecutivo-administracion.schema';
import {
  Pqr,
  type EstadoPqrGuardado,
  type EventoPqr,
  type PqrDocument,
  type ResponsablePqr,
  type TipoPqr,
} from '../../database/schemas/administracion/pqr.schema';
import {
  Tecnico,
  type TecnicoDocument,
} from '../../database/schemas/administracion/tecnico.schema';
import {
  cuentaParaAccesoDe,
  PortalAccesoService,
  type UnidadPortal,
} from '../portal/portal-acceso.service';
import type { ActualizarPqrDto } from './dto/actualizar-pqr.dto';
import type { CerrarPqrDto } from './dto/cerrar-pqr.dto';
import type { ClasificarPqrDto } from './dto/clasificar-pqr.dto';
import type { CrearPqrDto } from './dto/guardar-pqr.dto';
import type { CrearTareaPqrDto } from './dto/guardar-tarea-pqr.dto';
import type { CrearPqrPortalDto } from './dto/guardar-pqr-portal.dto';
import type { CrearSeguimientoDto } from './dto/guardar-seguimiento.dto';
import type { ListarPqrDto } from './dto/listar-pqr.dto';
import { filtroPqr, poblarTecnico } from './pqr-consultas';
import {
  estadoActual,
  evento,
  VALORES_ABIERTOS,
  valoresDeEstado,
} from './pqr-etapas';
import { PqrNotificacionesService } from './pqr-notificaciones.service';
import {
  desdeCrearDto,
  desdePortalDto,
  normalizarPrioridad,
  toPqr,
  toPqrPortal,
} from './pqr.mapper';
import { TareasService } from '../tareas/tareas.service';

/** How a resident's role on a unit reads on the PQR card. */
const ROL_VISIBLE = {
  propietario: 'Propietario',
  arrendatario: 'Arrendatario',
} as const;

/** Open stored values typed for a filter on the `estado` column. */
const ABIERTOS_GUARDADOS = VALORES_ABIERTOS as EstadoPqrGuardado[];

const MENSAJE_CERRADA = 'Esta PQRS ya está cerrada.';
const MENSAJE_SIN_PERMISO_TAREAS = 'Necesitas el permiso de gestionar tareas.';
const MENSAJE_CAMBIO = 'La PQRS cambió mientras se procesaba.';

/** Type labels as they read in the log. */
const ETIQUETA_TIPO: Record<TipoPqr, string> = {
  peticiones: 'Petición',
  quejas: 'Queja',
  reclamos: 'Reclamo',
  sugerencias: 'Sugerencia',
  felicitaciones: 'Felicitación',
  denuncias: 'Denuncia',
};

/** Responsible-body labels as they read in the log. */
const ETIQUETA_RESPONSABLE: Record<ResponsablePqr, string> = {
  administracion: 'Administración',
  consejo: 'Consejo de Administración',
  comite_convivencia: 'Comité de Convivencia',
};

/** `d/M/yyyy` of a Bogotá business day stored at UTC midnight. */
const fechaCorta = (fecha: Date): string =>
  `${fecha.getUTCDate()}/${fecha.getUTCMonth() + 1}/${fecha.getUTCFullYear()}`;

/** A `YYYY-MM-DD` day (already validated by the DTO) as UTC midnight. */
const diaDesdeTexto = (dia: string): Date => new Date(`${dia}T00:00:00.000Z`);

/** Stage values a staff PATCH may no longer set: closing has its own route. */
const ESTADOS_DE_CIERRE: string[] = ['resuelto', 'cerrado', 'cerrada'];

/**
 * PQRs (petitions, complaints, claims) of the ACTIVE coproperty. The tenant
 * always comes from the request context; every lookup and write filters by id
 * AND `copropiedadId`, so a PQR id of another building is a plain 404.
 *
 * Two audiences use this service and the split is the security model:
 *
 * - Staff (`PqrController`, CASL): see every PQR of the coproperty; `manage` is
 *   needed to change one, classify it, answer or close it, or register one.
 * - Residents (`PqrPortalController`, `PortalGuard`, no CASL): file PQRs from a
 *   unit they hold, see ONLY the ones they filed (without the internal
 *   handling: `PqrPortal`) and write only on those. Every `...Propia` /
 *   `...Residente` method narrows its filter by `autorId`, so a PQR of
 *   somebody else is indistinguishable from one that does not exist.
 *
 * The thread, the technician, the stage and the log are only ever changed
 * through atomic operators on a tenant-scoped filter, never by saving a whole
 * document back over concurrent writers. Every transition that decides from a
 * read puts the stored `estado` it read in the update filter.
 */
const ETIQUETA_PRIORIDAD: Record<string, string> = {
  alta: 'Alta',
  media: 'Media',
  normal: 'Normal',
  baja: 'Baja',
};

@Injectable()
export class PqrService {
  private readonly logger = new Logger(PqrService.name);

  constructor(
    @InjectModel(Pqr.name)
    private readonly pqrs: Model<PqrDocument>,
    @InjectModel(Tecnico.name)
    private readonly tecnicos: Model<TecnicoDocument>,
    @InjectModel(ConsecutivoAdministracion.name)
    private readonly consecutivos: Model<ConsecutivoAdministracionDocument>,
    private readonly tenant: TenantContextService,
    private readonly portalAcceso: PortalAccesoService,
    private readonly notificaciones: PqrNotificacionesService,
    private readonly tareas: TareasService,
  ) {}

  /** A malformed id can never match: answer 404 instead of a cast error (500). */
  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`PQR ${id} no encontrada`);
    }
  }

  /**
   * The account behind a resident request. `PortalGuard` already requires one,
   * but "not an author" must never degrade into "matches everybody": without a
   * usable account id the request is refused.
   */
  private cuentaDelResidente(user: IRequestUser): Types.ObjectId {
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new ForbiddenException('No se pudo identificar tu cuenta');
    }
    return new Types.ObjectId(user.accountId);
  }

  /** Re-reads a PQR WITH its technician's name, scoped by tenant like every lookup. */
  private async cargar(
    id: Types.ObjectId | string,
    copropiedadId: Types.ObjectId,
    soloDe?: Types.ObjectId,
  ): Promise<PqrDocument | null> {
    return this.pqrs
      .findOne(filtroPqr(id, copropiedadId, soloDe))
      .populate(poblarTecnico(copropiedadId))
      .exec();
  }

  /** A PQR of the tenant (optionally only the resident's own) or a 404. */
  private async cargarOFallar(
    id: string,
    soloDe?: Types.ObjectId,
  ): Promise<PqrDocument> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.cargar(id, copropiedadId, soloDe);
    if (!documento) throw new NotFoundException(`PQR ${id} no encontrada`);
    return documento;
  }

  /**
   * Unpopulated read used by the transitions: they compare against the STORED
   * values (the `estado` they put in the update filter, the technician id).
   */
  private async leerOFallar(
    id: string,
    copropiedadId: Types.ObjectId,
  ): Promise<PqrDocument> {
    const documento = await this.pqrs
      .findOne(filtroPqr(id, copropiedadId))
      .exec();
    if (!documento) throw new NotFoundException(`PQR ${id} no encontrada`);
    return documento;
  }

  /** After a conditional update matched nothing: the PQR is in the wrong state (409) or gone (404). */
  private async falloDeEscritura(
    id: string,
    copropiedadId: Types.ObjectId,
    mensajeSiExiste: string,
    soloDe?: Types.ObjectId,
  ): Promise<never> {
    const existe = await this.pqrs
      .findOne(filtroPqr(id, copropiedadId, soloDe))
      .select('_id')
      .exec();
    if (existe) throw new ConflictException(mensajeSiExiste);
    throw new NotFoundException(`PQR ${id} no encontrada`);
  }

  /**
   * The coproperty's PQRs, newest first, optionally narrowed by type/stage/
   * author. A stage filter matches the legacy stored values too; `vencidas`
   * (staff only: a resident never sees deadlines) keeps the open ones whose
   * deadline day is before today in Bogotá.
   */
  private async consultar(
    filtros: ListarPqrDto,
    soloDe?: Types.ObjectId,
  ): Promise<PqrDocument[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };
    if (soloDe) filtro.autorId = soloDe;
    if (filtros.tipo && filtros.tipo !== 'todos') filtro.tipo = filtros.tipo;
    let valores: string[] | undefined;
    if (filtros.estado && filtros.estado !== 'todos') {
      valores = valoresDeEstado(estadoActual(filtros.estado));
    }
    if (filtros.vencidas && !soloDe) {
      valores = valores
        ? valores.filter((valor) => VALORES_ABIERTOS.includes(valor))
        : VALORES_ABIERTOS;
      filtro.fechaLimite = { $lt: diaBogota(new Date()) };
    }
    if (valores) filtro.estado = { $in: valores };
    return this.pqrs
      .find(filtro)
      .populate(poblarTecnico(copropiedadId))
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Persists a new PQR (with its `PQR-001` code), logs the acknowledgment sent
   * to whoever it is about and tells the staff who can read it. Shared by both
   * audiences: only the fields differ.
   */
  private async guardar(
    campos: Record<string, unknown>,
    copropiedadId: Types.ObjectId,
    creadorId?: string,
  ): Promise<PqrDocument> {
    const codigo = await siguienteCodigo(this.consecutivos, 'PQR');
    const creada = await new this.pqrs({ ...campos, codigo }).save();
    const acuse = await this.notificaciones.notificarAcuse(
      creada,
      copropiedadId,
    );
    try {
      await this.pqrs
        .updateOne(filtroPqr(creada._id, copropiedadId), {
          $push: { bitacora: acuse },
        })
        .exec();
    } catch {
      // Best-effort: the PQR already exists; never answer 500 for a log entry.
      this.logger.warn(
        `Acuse no registrado en la bitácora de ${creada.codigo}: fallo_escritura`,
      );
    }
    await this.notificaciones.notificarNueva(creada, copropiedadId, creadorId);
    const poblada = await this.cargar(creada._id, copropiedadId);
    return poblada ?? creada;
  }

  /**
   * Appends a reply with one `$push` (and, for staff, its `respuesta` log entry
   * in the same update), so two people answering at once cannot drop each
   * other's entry. A closed PQR takes no more replies. The author name is
   * always the caller's own, and the PQR's author (if somebody else) is told.
   */
  private async agregarSeguimiento(
    id: string,
    dto: CrearSeguimientoDto,
    user: IRequestUser,
    soloDe?: Types.ObjectId,
  ): Promise<PqrDocument> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const autor = user.nombre || 'Usuario';
    const empujes: Record<string, unknown> = {
      seguimientos: { autor, mensaje: dto.mensaje, fecha: new Date() },
    };
    if (!soloDe) {
      empujes.bitacora = evento('respuesta', `Respuesta de ${autor}`, {
        nombre: autor,
        accountId: user.accountId,
      });
    }
    const documento = await this.pqrs
      .findOneAndUpdate(
        {
          ...filtroPqr(id, copropiedadId, soloDe),
          estado: { $in: ABIERTOS_GUARDADOS },
        },
        { $push: empujes },
        { new: true },
      )
      .populate(poblarTecnico(copropiedadId))
      .exec();
    if (!documento) {
      return this.falloDeEscritura(id, copropiedadId, MENSAJE_CERRADA, soloDe);
    }

    await this.notificaciones.notificarRespuesta(
      documento,
      copropiedadId,
      { accountId: user.accountId, nombre: autor },
      dto.mensaje,
    );
    return documento;
  }

  // ─── Staff ─────────────────────────────────────────────────────────────

  /**
   * Registers a PQR on somebody's behalf. It has no author account (nobody to
   * notify of replies later), and the person who filed it is not told about it.
   */
  async crear(dto: CrearPqrDto, user: IRequestUser): Promise<PqrContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    return toPqr(
      await this.guardar(
        desdeCrearDto(dto, copropiedadId, {
          nombre: user.nombre || 'Usuario',
          accountId: user.accountId,
        }),
        copropiedadId,
        user.accountId,
      ),
    );
  }

  /** Every PQR of the active coproperty. */
  async listar(filtros: ListarPqrDto): Promise<PqrContrato[]> {
    const hoy = diaBogota(new Date());
    const documentos = await this.consultar(filtros);
    return documentos.map((documento) => toPqr(documento, hoy));
  }

  /** One PQR of the active coproperty. */
  async obtener(id: string): Promise<PqrContrato> {
    return toPqr(await this.cargarOFallar(id));
  }

  /**
   * Classification step: type, responsible body and deadline. Repeatable until
   * the PQR is closed. One conditional update whose filter carries the stored
   * `estado` that was read, so a concurrent change is a 409, never a silent
   * overwrite; a legacy row converts to its stage when touched. Moving the PQR
   * to the Consejo / Comité (a different body than before) also notifies it.
   */
  async clasificar(
    id: string,
    dto: ClasificarPqrDto,
    user: IRequestUser,
  ): Promise<PqrContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const actual = await this.leerOFallar(id, copropiedadId);
    const etapa = estadoActual(actual.estado);
    if (etapa === 'cerrada') throw new ConflictException(MENSAJE_CERRADA);

    const radicadaEn =
      (actual as unknown as { createdAt?: Date }).createdAt ?? new Date();
    const limite = diaDesdeTexto(dto.fechaLimite);
    if (limite.getTime() < diaBogota(radicadaEn).getTime()) {
      throw new BadRequestException(
        'La fecha límite no puede ser anterior a la fecha de radicación.',
      );
    }

    const actor = {
      nombre: user.nombre || 'Usuario',
      accountId: user.accountId,
    };
    const tipo =
      actual.tipo === dto.tipo
        ? ETIQUETA_TIPO[dto.tipo]
        : `${ETIQUETA_TIPO[actual.tipo]} → ${ETIQUETA_TIPO[dto.tipo]}`;
    const detalle =
      `Clasificada: ${tipo} · Responsable: ` +
      `${ETIQUETA_RESPONSABLE[dto.responsable]} · Límite: ${fechaCorta(limite)}`;

    const cambios: Record<string, unknown> = {
      tipo: dto.tipo,
      responsable: dto.responsable,
      fechaLimite: limite,
      estado: etapa === 'radicada' ? 'clasificada' : etapa,
    };
    if (!actual.clasificadaEn) cambios.clasificadaEn = new Date();

    const clasificada = await this.pqrs
      .findOneAndUpdate(
        { ...filtroPqr(id, copropiedadId), estado: actual.estado },
        {
          $set: cambios,
          $push: { bitacora: evento('clasificada', detalle, actor) },
        },
        { new: true },
      )
      .populate(poblarTecnico(copropiedadId))
      .exec();
    if (!clasificada) throw new ConflictException(MENSAJE_CAMBIO);

    if (
      dto.responsable !== 'administracion' &&
      dto.responsable !== actual.responsable
    ) {
      try {
        const aviso = await this.notificaciones.avisarOrgano(
          clasificada,
          copropiedadId,
          dto.responsable,
        );
        const conAviso = await this.pqrs
          .findOneAndUpdate(
            filtroPqr(id, copropiedadId),
            { $push: { bitacora: aviso } },
            { new: true },
          )
          .populate(poblarTecnico(copropiedadId))
          .exec();
        return toPqr(conAviso ?? clasificada);
      } catch {
        // Best-effort: the PQR is already classified; never answer 500 here.
        this.logger.warn(
          `Aviso al órgano no registrado en ${clasificada.codigo}: fallo_escritura`,
        );
        return toPqr(clasificada);
      }
    }
    return toPqr(clasificada);
  }

  /**
   * Answers the resident and closes the PQR in ONE conditional update (the
   * filter only matches an open one), so two simultaneous closings cannot both
   * win. The e-mail goes out after, and never fails the closing.
   */
  async cerrar(
    id: string,
    dto: CerrarPqrDto,
    user: IRequestUser,
  ): Promise<PqrContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const nombre = user.nombre || 'Usuario';
    const ahora = new Date();
    const cerrada = await this.pqrs
      .findOneAndUpdate(
        {
          ...filtroPqr(id, copropiedadId),
          estado: { $in: ABIERTOS_GUARDADOS },
        },
        {
          $push: {
            seguimientos: { autor: nombre, mensaje: dto.mensaje, fecha: ahora },
            bitacora: evento('cerrada', `Respondida y cerrada por ${nombre}`, {
              nombre,
              accountId: user.accountId,
            }),
          },
          $set: { estado: 'cerrada', cerradaEn: ahora, cerradaPor: nombre },
        },
        { new: true },
      )
      .populate(poblarTecnico(copropiedadId))
      .exec();
    if (!cerrada) {
      return this.falloDeEscritura(id, copropiedadId, MENSAJE_CERRADA);
    }
    await this.notificaciones.notificarCierre(
      cerrada,
      copropiedadId,
      dto.mensaje,
    );
    return toPqr(cerrada);
  }

  /**
   * Legacy-compatible `PATCH`: priority and technician only. The stage is no
   * longer set from here (closing has its own route; the other stage values an
   * old client may send are ignored); `urgente` reads as priority `alta`. A
   * technician needs a classified PQR; assigning one to a `clasificada` moves
   * it to `en_gestion`. Same read-then-conditional-update pattern as
   * `clasificar`.
   */
  async actualizar(
    id: string,
    dto: ActualizarPqrDto,
    user: IRequestUser,
  ): Promise<PqrContrato> {
    this.validarId(id);
    if (dto.estado && ESTADOS_DE_CIERRE.includes(dto.estado)) {
      throw new BadRequestException(
        'Usa «Responder y cerrar» para cerrar la PQRS.',
      );
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const prioridadPedida =
      dto.prioridad !== undefined
        ? normalizarPrioridad(dto.prioridad)
        : dto.estado === 'urgente'
          ? 'alta'
          : undefined;
    if (prioridadPedida === undefined && dto.tecnicoId === undefined) {
      return toPqr(await this.cargarOFallar(id));
    }

    const actual = await this.leerOFallar(id, copropiedadId);
    const etapa = estadoActual(actual.estado);
    const actor = {
      nombre: user.nombre || 'Usuario',
      accountId: user.accountId,
    };
    const cambios: Record<string, unknown> = {};
    const eventos: EventoPqr[] = [];
    let tecnicoNuevo: { nombre: string; email: string } | null = null;

    if (prioridadPedida !== undefined && prioridadPedida !== actual.prioridad) {
      cambios.prioridad = prioridadPedida;
      eventos.push(
        evento(
          'prioridad',
          `Prioridad: ${ETIQUETA_PRIORIDAD[actual.prioridad] ?? actual.prioridad} → ${ETIQUETA_PRIORIDAD[prioridadPedida] ?? prioridadPedida}`,
          actor,
        ),
      );
    }

    if (dto.tecnicoId !== undefined) {
      if (etapa === 'radicada') {
        throw new ConflictException(
          'Clasifica la PQRS antes de asignar un técnico.',
        );
      }
      if (etapa === 'cerrada') throw new ConflictException(MENSAJE_CERRADA);
      const actualId = actual.tecnicoId?.toString() ?? null;
      if (dto.tecnicoId === null) {
        if (actualId) {
          cambios.tecnicoId = null;
          eventos.push(evento('tecnico_retirado', 'Técnico retirado', actor));
        }
      } else {
        if (!Types.ObjectId.isValid(dto.tecnicoId)) {
          throw new NotFoundException('Técnico no encontrado');
        }
        const tecnico = await this.tecnicos
          .findOne({ _id: dto.tecnicoId, copropiedadId })
          .select('_id nombre email')
          .exec();
        if (!tecnico) throw new NotFoundException('Técnico no encontrado');
        if (tecnico._id.toString() !== actualId) {
          cambios.tecnicoId = tecnico._id;
          tecnicoNuevo = { nombre: tecnico.nombre, email: tecnico.email ?? '' };
          eventos.push(
            evento(
              'tecnico_asignado',
              `Técnico asignado: ${tecnico.nombre}`,
              actor,
            ),
          );
          if (etapa === 'clasificada') {
            cambios.estado = 'en_gestion';
            eventos.push(evento('en_gestion', 'En gestión', actor));
          }
        }
      }
    }

    if (eventos.length === 0) return toPqr(await this.cargarOFallar(id));

    const documento = await this.pqrs
      .findOneAndUpdate(
        { ...filtroPqr(id, copropiedadId), estado: actual.estado },
        { $set: cambios, $push: { bitacora: { $each: eventos } } },
        { new: true },
      )
      .populate(poblarTecnico(copropiedadId))
      .exec();
    if (!documento) throw new ConflictException(MENSAJE_CAMBIO);

    if (tecnicoNuevo) {
      try {
        const aviso = await this.notificaciones.notificarTecnico(
          documento,
          copropiedadId,
          tecnicoNuevo,
        );
        const conAviso = await this.pqrs
          .findOneAndUpdate(
            filtroPqr(id, copropiedadId),
            { $push: { bitacora: aviso } },
            { new: true },
          )
          .populate(poblarTecnico(copropiedadId))
          .exec();
        return toPqr(conAviso ?? documento);
      } catch {
        // Best-effort: the technician is already assigned; never answer 500 here.
        this.logger.warn(
          `Aviso al técnico no registrado en ${documento.codigo}: fallo_escritura`,
        );
      }
    }
    return toPqr(documento);
  }

  /**
   * Creates a task linked to this PQRS (needs `tareas.gestionar`: the route
   * itself is judged by `manage Pqr`). The task is the primary write; the PQRS
   * log entry (and `clasificada` → `en_gestion`) is best-effort, in ONE update
   * conditional on the stored `estado` that was read, with a plain `$push`
   * retry if a concurrent writer moved the stage meanwhile.
   */
  async crearTarea(
    id: string,
    dto: CrearTareaPqrDto,
    user: IRequestUser,
  ): Promise<TareaContrato> {
    if (
      !user.isPlatformAdmin &&
      !user.permissions?.includes('tareas.gestionar')
    ) {
      throw new ForbiddenException(MENSAJE_SIN_PERMISO_TAREAS);
    }
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const actual = await this.leerOFallar(id, copropiedadId);
    const etapa = estadoActual(actual.estado);
    if (etapa === 'radicada') {
      throw new ConflictException('Clasifica la PQRS antes de crear tareas.');
    }
    if (etapa === 'cerrada') throw new ConflictException(MENSAJE_CERRADA);

    const tarea = await this.tareas.crear(
      { ...dto, categoria: dto.categoria ?? 'admin' },
      user,
      { pqrId: actual._id, pqrCodigo: actual.codigo },
    );

    try {
      const actor = {
        nombre: user.nombre || 'Usuario',
        accountId: user.accountId,
      };
      const nombres = tarea.asignados.map((a) => a.nombre).join(', ');
      const eventos: EventoPqr[] = [
        evento(
          'tarea_creada',
          `Tarea «${tarea.titulo}» asignada a ${nombres}`,
          actor,
        ),
      ];
      const actualizacion: Record<string, unknown> = {};
      if (etapa === 'clasificada') {
        eventos.push(evento('en_gestion', 'En gestión', actor));
        actualizacion.$set = { estado: 'en_gestion' };
      }
      actualizacion.$push = { bitacora: { $each: eventos } };
      const aplicada = await this.pqrs
        .findOneAndUpdate(
          { ...filtroPqr(id, copropiedadId), estado: actual.estado },
          actualizacion,
        )
        .exec();
      if (!aplicada) {
        await this.pqrs
          .updateOne(
            {
              ...filtroPqr(id, copropiedadId),
              estado: { $in: ABIERTOS_GUARDADOS },
            },
            { $push: { bitacora: eventos[0] } },
          )
          .exec();
      }
    } catch {
      // Best-effort: the task exists; never answer 500 over its log entry.
      this.logger.warn(
        `Tarea creada sin registrar en la bitácora de ${actual.codigo}: fallo_escritura`,
      );
    }
    return tarea;
  }

  /** The tasks linked to one PQRS of the tenant; a PQRS of another building is a 404. */
  async listarTareas(id: string): Promise<TareaDePqr[]> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const pqr = await this.pqrs
      .findOne(filtroPqr(id, copropiedadId))
      .select('_id')
      .exec();
    if (!pqr) throw new NotFoundException(`PQR ${id} no encontrada`);
    return this.tareas.listarDePqr(pqr._id);
  }

  /** Staff reply on any open PQR of the coproperty. */
  async responder(
    id: string,
    dto: CrearSeguimientoDto,
    user: IRequestUser,
  ): Promise<PqrContrato> {
    return toPqr(await this.agregarSeguimiento(id, dto, user));
  }

  // ─── Resident ──────────────────────────────────────────────────────────

  /**
   * The unit a resident files under: one of the units they actually hold, found
   * through the same derivation as the rest of the portal. Without this a client
   * could write any unit text. A resident with a single unit may omit it.
   */
  private resolverUnidad(
    pedida: string | undefined,
    unidades: UnidadPortal[],
  ): UnidadPortal {
    const codigo = pedida?.trim();
    if (!codigo) {
      if (unidades.length === 1) return unidades[0];
      throw new BadRequestException(
        unidades.length === 0
          ? 'No tenés inmuebles en esta copropiedad'
          : 'Indicá desde qué inmueble reportás',
      );
    }
    const unidad = unidades.find(
      (u) => u.codigo.toLowerCase() === codigo.toLowerCase(),
    );
    if (!unidad) {
      throw new ForbiddenException(
        'El inmueble indicado no es uno de los tuyos',
      );
    }
    return unidad;
  }

  /**
   * Files a PQR as a resident. The reporter's data (author account, unit code,
   * name and the role they hold on that unit) is resolved here, never read from
   * the payload; the status starts `radicada`.
   */
  async crearComoResidente(
    dto: CrearPqrPortalDto,
    user: IRequestUser,
  ): Promise<PqrPortal> {
    const autorId = this.cuentaDelResidente(user);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const unidades = await this.portalAcceso.unidadesDe(
      autorId.toString(),
      copropiedadId.toString(),
      cuentaParaAccesoDe(user),
    );
    const unidad = this.resolverUnidad(dto.unidad, unidades);
    return toPqrPortal(
      await this.guardar(
        desdePortalDto(dto, copropiedadId, {
          autorId,
          unidad: unidad.codigo,
          nombre: user.nombre?.trim() || 'Residente',
          rol: ROL_VISIBLE[unidad.rol],
        }),
        copropiedadId,
        autorId.toString(),
      ),
    );
  }

  /** Only the PQRs the caller filed. */
  async listarPropias(
    filtros: ListarPqrDto,
    user: IRequestUser,
  ): Promise<PqrPortal[]> {
    const documentos = await this.consultar(
      filtros,
      this.cuentaDelResidente(user),
    );
    return documentos.map((documento) => toPqrPortal(documento));
  }

  /** One PQR, if the caller filed it; otherwise a 404. */
  async obtenerPropia(id: string, user: IRequestUser): Promise<PqrPortal> {
    return toPqrPortal(
      await this.cargarOFallar(id, this.cuentaDelResidente(user)),
    );
  }

  /** A reply by the resident on a PQR they filed and is still open; otherwise 404 / 409. */
  async responderPropia(
    id: string,
    dto: CrearSeguimientoDto,
    user: IRequestUser,
  ): Promise<PqrPortal> {
    return toPqrPortal(
      await this.agregarSeguimiento(
        id,
        dto,
        user,
        this.cuentaDelResidente(user),
      ),
    );
  }
}

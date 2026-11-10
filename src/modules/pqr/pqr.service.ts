import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { siguienteCodigo } from '../../common/consecutivos/codigo-consecutivo';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { Pqr as PqrContrato } from '../../contracts';
import {
  ConsecutivoAdministracion,
  type ConsecutivoAdministracionDocument,
} from '../../database/schemas/administracion/consecutivo-administracion.schema';
import {
  Pqr,
  type PqrDocument,
} from '../../database/schemas/administracion/pqr.schema';
import {
  Tecnico,
  type TecnicoDocument,
} from '../../database/schemas/administracion/tecnico.schema';
import {
  PortalAccesoService,
  type UnidadPortal,
} from '../portal/portal-acceso.service';
import type { ActualizarPqrDto } from './dto/actualizar-pqr.dto';
import type { CrearPqrDto } from './dto/guardar-pqr.dto';
import type { CrearPqrPortalDto } from './dto/guardar-pqr-portal.dto';
import type { CrearSeguimientoDto } from './dto/guardar-seguimiento.dto';
import type { ListarPqrDto } from './dto/listar-pqr.dto';
import { filtroPqr, poblarTecnico } from './pqr-consultas';
import { PqrNotificacionesService } from './pqr-notificaciones.service';
import {
  desdeCrearDto,
  desdePortalDto,
  normalizarPrioridad,
  toPqr,
} from './pqr.mapper';

/** How a resident's role on a unit reads on the PQR card. */
const ROL_VISIBLE = {
  propietario: 'Propietario',
  arrendatario: 'Arrendatario',
} as const;

/**
 * PQRs (petitions, complaints, claims) of the ACTIVE coproperty. The tenant
 * always comes from the request context; every lookup and write filters by id
 * AND `copropiedadId`, so a PQR id of another building is a plain 404.
 *
 * Two audiences use this service and the split is the security model:
 *
 * - Staff (`PqrController`, CASL): see every PQR of the coproperty; `manage` is
 *   needed to change one, answer it or register one.
 * - Residents (`PqrPortalController`, `PortalGuard`, no CASL): file PQRs from a
 *   unit they hold, see ONLY the ones they filed and write only on those. Every
 *   `...Propia` / `...Residente` method narrows its filter by `autorId`, so a
 *   PQR of somebody else is indistinguishable from one that does not exist.
 *
 * The thread, the technician and the status are only ever changed through
 * atomic operators on a tenant-scoped filter, never by saving a whole document
 * back over concurrent writers.
 */
@Injectable()
export class PqrService {
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

  private async cargarOFallar(
    id: string,
    soloDe?: Types.ObjectId,
  ): Promise<PqrContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const documento = await this.cargar(id, copropiedadId, soloDe);
    if (!documento) throw new NotFoundException(`PQR ${id} no encontrada`);
    return toPqr(documento);
  }

  /** The coproperty's PQRs, newest first, optionally narrowed by type/status/author. */
  private async consultar(
    filtros: ListarPqrDto,
    soloDe?: Types.ObjectId,
  ): Promise<PqrContrato[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro: Record<string, unknown> = { copropiedadId };
    if (soloDe) filtro.autorId = soloDe;
    if (filtros.tipo && filtros.tipo !== 'todos') filtro.tipo = filtros.tipo;
    if (filtros.estado && filtros.estado !== 'todos') {
      filtro.estado = filtros.estado;
    }
    const documentos = await this.pqrs
      .find(filtro)
      .populate(poblarTecnico(copropiedadId))
      .sort({ createdAt: -1 })
      .exec();
    return documentos.map(toPqr);
  }

  /**
   * Persists a new PQR (with its `PQR-001` code) and tells the staff who can
   * read it. Shared by both audiences: only the fields differ.
   */
  private async guardar(
    campos: Record<string, unknown>,
    copropiedadId: Types.ObjectId,
    creadorId?: string,
  ): Promise<PqrContrato> {
    const codigo = await siguienteCodigo(this.consecutivos, 'PQR');
    const creada = await new this.pqrs({ ...campos, codigo }).save();
    await this.notificaciones.notificarNueva(creada, copropiedadId, creadorId);
    const poblada = await this.cargar(creada._id, copropiedadId);
    return toPqr(poblada ?? creada);
  }

  /**
   * Appends a reply with one `$push`, so two people answering at once cannot
   * drop each other's entry. The author name is always the caller's own, and
   * the PQR's author (if somebody else) is told.
   */
  private async agregarSeguimiento(
    id: string,
    dto: CrearSeguimientoDto,
    user: IRequestUser,
    soloDe?: Types.ObjectId,
  ): Promise<PqrContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const autor = user.nombre || 'Usuario';
    const documento = await this.pqrs
      .findOneAndUpdate(
        filtroPqr(id, copropiedadId, soloDe),
        {
          $push: {
            seguimientos: {
              autor,
              mensaje: dto.mensaje,
              fecha: new Date(),
            },
          },
        },
        { new: true },
      )
      .populate(poblarTecnico(copropiedadId))
      .exec();
    if (!documento) throw new NotFoundException(`PQR ${id} no encontrada`);

    await this.notificaciones.notificarRespuesta(
      documento,
      copropiedadId,
      { accountId: user.accountId, nombre: autor },
      dto.mensaje,
    );
    return toPqr(documento);
  }

  // ─── Staff ─────────────────────────────────────────────────────────────

  /**
   * Registers a PQR on somebody's behalf. It has no author account (nobody to
   * notify of replies later), and the person who filed it is not told about it.
   */
  async crear(dto: CrearPqrDto, user: IRequestUser): Promise<PqrContrato> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    return this.guardar(
      desdeCrearDto(dto, copropiedadId),
      copropiedadId,
      user.accountId,
    );
  }

  /** Every PQR of the active coproperty. */
  listar(filtros: ListarPqrDto): Promise<PqrContrato[]> {
    return this.consultar(filtros);
  }

  /** One PQR of the active coproperty. */
  obtener(id: string): Promise<PqrContrato> {
    return this.cargarOFallar(id);
  }

  /**
   * Changes status, priority and/or the assigned technician. A technician is
   * only assignable if it belongs to the active coproperty. Only the fields the
   * client sent are written.
   */
  async actualizar(id: string, dto: ActualizarPqrDto): Promise<PqrContrato> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const cambios: Record<string, unknown> = {};
    if (dto.estado !== undefined) cambios.estado = dto.estado;
    if (dto.prioridad !== undefined) {
      cambios.prioridad = normalizarPrioridad(dto.prioridad);
    }
    if (dto.tecnicoId !== undefined) {
      if (dto.tecnicoId === null) {
        cambios.tecnicoId = null;
      } else {
        if (!Types.ObjectId.isValid(dto.tecnicoId)) {
          throw new NotFoundException('Técnico no encontrado');
        }
        const tecnico = await this.tecnicos
          .findOne({ _id: dto.tecnicoId, copropiedadId })
          .select('_id')
          .exec();
        if (!tecnico) throw new NotFoundException('Técnico no encontrado');
        cambios.tecnicoId = tecnico._id;
      }
    }

    if (Object.keys(cambios).length === 0) return this.cargarOFallar(id);

    const documento = await this.pqrs
      .findOneAndUpdate(
        filtroPqr(id, copropiedadId),
        { $set: cambios },
        { new: true },
      )
      .populate(poblarTecnico(copropiedadId))
      .exec();
    if (!documento) throw new NotFoundException(`PQR ${id} no encontrada`);
    return toPqr(documento);
  }

  /** Staff reply on any PQR of the coproperty. */
  responder(
    id: string,
    dto: CrearSeguimientoDto,
    user: IRequestUser,
  ): Promise<PqrContrato> {
    return this.agregarSeguimiento(id, dto, user);
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
   * the payload; the status starts `pendiente`.
   */
  async crearComoResidente(
    dto: CrearPqrPortalDto,
    user: IRequestUser,
  ): Promise<PqrContrato> {
    const autorId = this.cuentaDelResidente(user);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const unidades = await this.portalAcceso.unidadesDe(
      autorId.toString(),
      copropiedadId.toString(),
    );
    const unidad = this.resolverUnidad(dto.unidad, unidades);
    return this.guardar(
      desdePortalDto(dto, copropiedadId, {
        autorId,
        unidad: unidad.codigo,
        nombre: user.nombre?.trim() || 'Residente',
        rol: ROL_VISIBLE[unidad.rol],
      }),
      copropiedadId,
      autorId.toString(),
    );
  }

  /** Only the PQRs the caller filed. */
  async listarPropias(
    filtros: ListarPqrDto,
    user: IRequestUser,
  ): Promise<PqrContrato[]> {
    return await this.consultar(filtros, this.cuentaDelResidente(user));
  }

  /** One PQR, if the caller filed it; otherwise a 404. */
  async obtenerPropia(id: string, user: IRequestUser): Promise<PqrContrato> {
    return await this.cargarOFallar(id, this.cuentaDelResidente(user));
  }

  /** A reply by the resident on a PQR they filed; otherwise a 404. */
  async responderPropia(
    id: string,
    dto: CrearSeguimientoDto,
    user: IRequestUser,
  ): Promise<PqrContrato> {
    return await this.agregarSeguimiento(
      id,
      dto,
      user,
      this.cuentaDelResidente(user),
    );
  }
}

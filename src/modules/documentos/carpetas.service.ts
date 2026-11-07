// src/modules/documentos/carpetas.service.ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  AclCarpetaAdministracion,
  CarpetaAdministracion,
  RutaCarpetaAdministracion,
} from '../../contracts';
import {
  ArchivoDocumento,
  type ArchivoDocumentoDocument,
} from '../../database/schemas/administracion/documento-archivo.schema';
import {
  CarpetaDocumento,
  type AclCarpetaDocumento,
  type CarpetaDocumentoDocument,
} from '../../database/schemas/administracion/documento-carpeta.schema';
import {
  Rol,
  type RolDocument,
} from '../../database/schemas/administracion/rol.schema';
import {
  accesoDelPersonal,
  aclsHeredados,
  type AccesoCarpeta,
  type ActorDocumentos,
} from './documentos-acceso';
import { DocumentosActorService } from './documentos-actor.service';
import type { ActualizarCarpetaDto } from './dto/actualizar-carpeta.dto';
import type { AclCarpetaDto, CrearCarpetaDto } from './dto/guardar-carpeta.dto';
import type { ListarCarpetasDto } from './dto/listar-documentos.dto';
import {
  toAcl,
  toCarpeta,
  type EstadisticasCarpeta,
} from './documentos.mapper';

/** Mongo's duplicate-key error code. */
const CLAVE_DUPLICADA = 11000;

/** Mapa id -> carpeta de UNA copropiedad: base de toda resolución de herencia. */
export type MapaCarpetas = Map<string, CarpetaDocumentoDocument>;

const slugificar = (valor: string): string =>
  valor
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const ESTADISTICAS_VACIAS = (carpeta: CarpetaDocumentoDocument) => ({
  archivos: 0,
  tamanoBytes: 0,
  actualizado: (
    (carpeta as unknown as { updatedAt?: Date }).updatedAt ?? new Date()
  ).toISOString(),
});

/**
 * Folders of the ACTIVE coproperty (the tenant always comes from the request
 * context). Every folder of a coproperty is loaded in ONE tenant-filtered query
 * and inheritance is resolved over that map: folder counts are small, and the
 * ancestor walk never issues an id-only lookup that could reach another
 * building's folder.
 *
 * Staff rules: reading and uploading follow the folder rules unless the caller
 * holds `gestionar`; creating, editing and deleting folders (and their rules)
 * is `gestionar` only, enforced by the route and again here.
 */
@Injectable()
export class CarpetasService {
  constructor(
    @InjectModel(CarpetaDocumento.name)
    private readonly carpetas: Model<CarpetaDocumentoDocument>,
    @InjectModel(ArchivoDocumento.name)
    private readonly archivos: Model<ArchivoDocumentoDocument>,
    @InjectModel(Rol.name) private readonly roles: Model<RolDocument>,
    private readonly tenant: TenantContextService,
    private readonly actores: DocumentosActorService,
  ) {}

  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Carpeta ${id} no encontrada`);
    }
  }

  private exigirGestion(actor: ActorDocumentos): void {
    if (!actor.gestiona) {
      throw new ForbiddenException(
        'Solo quien gestiona documentos puede administrar carpetas',
      );
    }
  }

  // ── Shared reads (also used by the file and portal services) ─────────

  /** Every folder of the coproperty, keyed by id. */
  async cargarMapa(copropiedadId: Types.ObjectId): Promise<MapaCarpetas> {
    const todas = await this.carpetas.find({ copropiedadId }).exec();
    return new Map(todas.map((c) => [c._id.toString(), c]));
  }

  /** Folder by slug within the coproperty; 404 when there is none. */
  resolverPorSlug(mapa: MapaCarpetas, slug: string): CarpetaDocumentoDocument {
    for (const carpeta of mapa.values()) {
      if (carpeta.slug === slug) return carpeta;
    }
    throw new NotFoundException(`Carpeta '${slug}' no encontrada`);
  }

  /** Count / size / last change per folder, over confirmed files only. */
  async estadisticas(
    copropiedadId: Types.ObjectId,
  ): Promise<Map<string, EstadisticasCarpeta>> {
    const filas = await this.archivos
      .aggregate<{
        _id: Types.ObjectId;
        archivos: number;
        tamanoBytes: number;
        actualizado: Date;
      }>([
        { $match: { copropiedadId, estado: 'listo' } },
        {
          $group: {
            _id: '$carpetaId',
            archivos: { $sum: 1 },
            tamanoBytes: { $sum: '$tamanoBytes' },
            actualizado: { $max: '$updatedAt' },
          },
        },
      ])
      .exec();
    return new Map(
      filas.map((f) => [
        f._id.toString(),
        {
          archivos: f.archivos,
          tamanoBytes: f.tamanoBytes,
          actualizado: f.actualizado.toISOString(),
        },
      ]),
    );
  }

  /**
   * Folder path as names ("A / B / C"). `visible` lets the portal leave out
   * ancestors the resident cannot read, so a breadcrumb never leaks their names.
   */
  rutaItems(
    carpetaId: string | null,
    mapa: ReadonlyMap<string, CarpetaDocumentoDocument>,
    visible: (c: CarpetaDocumentoDocument) => boolean = () => true,
  ): RutaCarpetaAdministracion[] {
    const items: RutaCarpetaAdministracion[] = [];
    const vistas = new Set<string>();
    let actual = carpetaId;
    while (actual && !vistas.has(actual)) {
      vistas.add(actual);
      const carpeta = mapa.get(actual);
      if (!carpeta) break;
      if (visible(carpeta)) {
        items.unshift({
          id: carpeta._id.toString(),
          slug: carpeta.slug,
          nombre: carpeta.nombre,
        });
      }
      actual = carpeta.carpetaPadreId
        ? carpeta.carpetaPadreId.toString()
        : null;
    }
    return items;
  }

  rutaTexto(
    carpetaId: string | null,
    mapa: ReadonlyMap<string, CarpetaDocumentoDocument>,
    visible?: (c: CarpetaDocumentoDocument) => boolean,
  ): string {
    return this.rutaItems(carpetaId, mapa, visible)
      .map((i) => i.nombre)
      .join(' / ');
  }

  /** Children of `padreId` (or the roots), by name. */
  hijas(
    mapa: MapaCarpetas,
    padreId: string | null,
  ): CarpetaDocumentoDocument[] {
    return [...mapa.values()]
      .filter(
        (c) =>
          (c.carpetaPadreId ? c.carpetaPadreId.toString() : null) === padreId,
      )
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  private herencia(
    carpeta: CarpetaDocumentoDocument,
    mapa: MapaCarpetas,
  ): {
    heredaDe: string | null;
    permisosHeredados: AclCarpetaAdministracion[];
  } {
    const { acls, origenId } = aclsHeredados(carpeta, mapa);
    return {
      heredaDe: origenId ? (mapa.get(origenId)?.nombre ?? null) : null,
      permisosHeredados: acls.map(toAcl),
    };
  }

  // ── Staff routes ─────────────────────────────────────────────────────

  /** Folders under `parent` (or the root) the caller may read, with their stats. */
  async listar(
    filtros: ListarCarpetasDto,
    user: IRequestUser,
  ): Promise<CarpetaAdministracion[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa, estadisticas] = await Promise.all([
      this.actores.deSolicitud(user),
      this.cargarMapa(copropiedadId),
      this.estadisticas(copropiedadId),
    ]);
    return this.hijas(mapa, filtros.parent ?? null)
      .map((carpeta) => ({
        carpeta,
        acceso: accesoDelPersonal(carpeta, actor, mapa),
      }))
      .filter(({ acceso }) => acceso.puedeLeer)
      .map(({ carpeta, acceso }) =>
        toCarpeta(
          carpeta,
          estadisticas.get(carpeta._id.toString()) ??
            ESTADISTICAS_VACIAS(carpeta),
          acceso,
          this.herencia(carpeta, mapa),
        ),
      );
  }

  /** Deep-link by slug. A folder the caller cannot read is a 403 for staff. */
  async porSlug(
    slug: string,
    user: IRequestUser,
  ): Promise<CarpetaAdministracion> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa, estadisticas] = await Promise.all([
      this.actores.deSolicitud(user),
      this.cargarMapa(copropiedadId),
      this.estadisticas(copropiedadId),
    ]);
    const carpeta = this.resolverPorSlug(mapa, slug);
    const acceso = accesoDelPersonal(carpeta, actor, mapa);
    if (!acceso.puedeLeer) {
      throw new ForbiddenException('No tenés acceso a esta carpeta');
    }
    return toCarpeta(
      carpeta,
      estadisticas.get(carpeta._id.toString()) ?? ESTADISTICAS_VACIAS(carpeta),
      acceso,
      this.herencia(carpeta, mapa),
    );
  }

  /** Breadcrumb root -> folder. The caller must be able to read the folder. */
  async ruta(
    id: string,
    user: IRequestUser,
  ): Promise<RutaCarpetaAdministracion[]> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa] = await Promise.all([
      this.actores.deSolicitud(user),
      this.cargarMapa(copropiedadId),
    ]);
    const carpeta = mapa.get(id);
    if (!carpeta) throw new NotFoundException(`Carpeta ${id} no encontrada`);
    if (!accesoDelPersonal(carpeta, actor, mapa).puedeLeer) {
      throw new ForbiddenException('No tenés acceso a esta carpeta');
    }
    return this.rutaItems(id, mapa);
  }

  /** Effective access of the caller over one folder of the map. */
  accesoDe(
    carpeta: CarpetaDocumentoDocument,
    actor: ActorDocumentos,
    mapa: MapaCarpetas,
  ): AccesoCarpeta {
    return accesoDelPersonal(carpeta, actor, mapa);
  }

  /**
   * Turns the client's rules into what gets stored. Rejects the mixed shapes the
   * DTO cannot express, makes residents read-only, and requires every `rolId` to
   * be a role of THIS coproperty (a role id of another building would otherwise
   * be stored and silently never match).
   */
  private async normalizarAcls(
    entradas: AclCarpetaDto[],
    copropiedadId: Types.ObjectId,
  ): Promise<AclCarpetaDocumento[]> {
    for (const e of entradas) {
      if (e.tipo === 'rol' && (e.rolId === undefined || e.rol !== undefined)) {
        throw new BadRequestException(
          'Una regla de rol lleva rolId y no lleva rol',
        );
      }
      if (e.tipo === 'residentes') {
        if (e.rol === undefined || e.rolId !== undefined) {
          throw new BadRequestException(
            'Una regla de residentes lleva rol y no lleva rolId',
          );
        }
        if (e.puedeEscribir) {
          throw new BadRequestException(
            'Los residentes solo pueden leer: puedeEscribir debe ser false',
          );
        }
      }
    }

    const rolIds = [
      ...new Set(
        entradas.flatMap((e) =>
          e.tipo === 'rol' && e.rolId !== undefined ? [e.rolId] : [],
        ),
      ),
    ];
    if (rolIds.length > 0) {
      const propios = await this.roles
        .find({ _id: { $in: rolIds }, copropiedadId })
        .select('_id')
        .lean()
        .exec();
      if (propios.length !== rolIds.length) {
        throw new BadRequestException(
          'Hay roles que no pertenecen a esta copropiedad',
        );
      }
    }

    return entradas.map((e) =>
      e.tipo === 'rol'
        ? {
            tipo: 'rol',
            rolId: new Types.ObjectId(e.rolId),
            puedeLeer: e.puedeLeer,
            puedeEscribir: e.puedeEscribir,
          }
        : {
            tipo: 'residentes',
            rol: e.rol,
            puedeLeer: e.puedeLeer,
            puedeEscribir: false,
          },
    );
  }

  /** Slugs are unique per coproperty; `-2`, `-3`... until free. The unique index backs races. */
  private slugLibre(base: string, mapa: MapaCarpetas): string {
    const usados = new Set([...mapa.values()].map((c) => c.slug));
    const raiz = slugificar(base) || 'carpeta';
    let candidato = raiz;
    for (let n = 2; usados.has(candidato); n += 1) candidato = `${raiz}-${n}`;
    return candidato;
  }

  /** Creates a folder (optionally nested). `gestionar` only. */
  async crear(
    dto: CrearCarpetaDto,
    user: IRequestUser,
  ): Promise<CarpetaAdministracion> {
    const actor = await this.actores.deSolicitud(user);
    this.exigirGestion(actor);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const mapa = await this.cargarMapa(copropiedadId);

    let carpetaPadreId: Types.ObjectId | null = null;
    if (dto.parentId) {
      const padre = mapa.get(dto.parentId);
      if (!padre) {
        throw new NotFoundException(`Carpeta ${dto.parentId} no encontrada`);
      }
      carpetaPadreId = padre._id;
    }
    const acls = await this.normalizarAcls(dto.acls ?? [], copropiedadId);

    let creada: CarpetaDocumentoDocument;
    try {
      creada = await new this.carpetas({
        copropiedadId,
        carpetaPadreId,
        slug: this.slugLibre(dto.slug ?? dto.nombre, mapa),
        nombre: dto.nombre,
        descripcion: dto.descripcion ?? '',
        icono: dto.icono ?? 'folder',
        color: dto.color ?? '#64748b',
        acls,
      }).save();
    } catch (error: unknown) {
      if ((error as { code?: number }).code === CLAVE_DUPLICADA) {
        throw new ConflictException(
          'Ya existe una carpeta con ese nombre; volvé a intentarlo',
        );
      }
      throw error;
    }
    mapa.set(creada._id.toString(), creada);
    return toCarpeta(
      creada,
      ESTADISTICAS_VACIAS(creada),
      accesoDelPersonal(creada, actor, mapa),
      this.herencia(creada, mapa),
    );
  }

  /** Edits name, description and/or rules; the slug never changes. `gestionar` only. */
  async actualizar(
    id: string,
    dto: ActualizarCarpetaDto,
    user: IRequestUser,
  ): Promise<CarpetaAdministracion> {
    this.validarId(id);
    const actor = await this.actores.deSolicitud(user);
    this.exigirGestion(actor);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const mapa = await this.cargarMapa(copropiedadId);
    if (!mapa.has(id))
      throw new NotFoundException(`Carpeta ${id} no encontrada`);

    const cambios: Record<string, unknown> = {};
    if (dto.nombre !== undefined) cambios.nombre = dto.nombre;
    if (dto.descripcion !== undefined) cambios.descripcion = dto.descripcion;
    if (dto.acls !== undefined) {
      cambios.acls = await this.normalizarAcls(dto.acls, copropiedadId);
    }

    const actualizada = await this.carpetas
      .findOneAndUpdate(
        { _id: id, copropiedadId },
        { $set: cambios },
        { new: true },
      )
      .exec();
    if (!actualizada)
      throw new NotFoundException(`Carpeta ${id} no encontrada`);
    mapa.set(id, actualizada);

    const estadisticas = await this.estadisticas(copropiedadId);
    return toCarpeta(
      actualizada,
      estadisticas.get(id) ?? ESTADISTICAS_VACIAS(actualizada),
      accesoDelPersonal(actualizada, actor, mapa),
      this.herencia(actualizada, mapa),
    );
  }

  /** Deletes an EMPTY folder (no files in any state, no subfolders). `gestionar` only. */
  async eliminar(id: string, user: IRequestUser): Promise<{ id: string }> {
    this.validarId(id);
    const actor = await this.actores.deSolicitud(user);
    this.exigirGestion(actor);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const _id = new Types.ObjectId(id);

    const [archivos, subcarpetas] = await Promise.all([
      this.archivos.countDocuments({ copropiedadId, carpetaId: _id }).exec(),
      this.carpetas
        .countDocuments({ copropiedadId, carpetaPadreId: _id })
        .exec(),
    ]);
    if (archivos > 0 || subcarpetas > 0) {
      throw new ConflictException(
        'No se puede eliminar una carpeta con archivos o subcarpetas',
      );
    }
    const borrada = await this.carpetas
      .deleteOne({ _id, copropiedadId })
      .exec();
    if (borrada.deletedCount !== 1) {
      throw new NotFoundException(`Carpeta ${id} no encontrada`);
    }
    return { id };
  }
}

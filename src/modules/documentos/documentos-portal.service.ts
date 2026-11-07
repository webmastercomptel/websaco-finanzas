// src/modules/documentos/documentos-portal.service.ts
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { escapeRegex } from '../../common/utils/query.utils';
import type {
  ArchivoAdministracion,
  CarpetaAdministracionPortal,
  DescargaArchivo,
  RutaCarpetaAdministracion,
} from '../../contracts';
import {
  ArchivoDocumento,
  type ArchivoDocumentoDocument,
} from '../../database/schemas/administracion/documento-archivo.schema';
import type { CarpetaDocumentoDocument } from '../../database/schemas/administracion/documento-carpeta.schema';
import { PortalAccesoService } from '../portal/portal-acceso.service';
import { CarpetasService, type MapaCarpetas } from './carpetas.service';
import { residentePuedeLeer, type TipoResidente } from './documentos-acceso';
import { DocumentosAlmacenService } from './documentos-almacen.service';
import { toArchivo, toCarpetaPortal } from './documentos.mapper';
import type {
  ListarCarpetasDto,
  ListarDocumentosDto,
} from './dto/listar-documentos.dto';

/**
 * READ-ONLY view of the library for residents (owners and tenants).
 *
 * A resident carries no CASL permissions, so authorization is data-level: the
 * caller's unit holdings in the ACTIVE coproperty say whether they are an owner,
 * a tenant or both, and a folder is visible only when its effective rules have a
 * `residentes` rule that reads for one of those. Anything else — a folder or a
 * file they may not see, or one that does not exist — is the SAME 404, so
 * nothing about hidden content leaks. There is no write method here and must
 * not be one.
 *
 * Folder rules, role ids and other audiences never leave this service: the
 * mappers it uses drop them.
 */
@Injectable()
export class DocumentosPortalService {
  constructor(
    @InjectModel(ArchivoDocumento.name)
    private readonly archivos: Model<ArchivoDocumentoDocument>,
    private readonly tenant: TenantContextService,
    private readonly carpetas: CarpetasService,
    private readonly portalAcceso: PortalAccesoService,
    private readonly almacen: DocumentosAlmacenService,
  ) {}

  private cuenta(user: IRequestUser): string {
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new ForbiddenException('No se pudo identificar tu cuenta');
    }
    return user.accountId;
  }

  /** How the caller holds units here: owner, tenant, both, or none. */
  private async tiposDe(
    user: IRequestUser,
    copropiedadId: Types.ObjectId,
  ): Promise<ReadonlySet<TipoResidente>> {
    const unidades = await this.portalAcceso.unidadesDe(
      this.cuenta(user),
      copropiedadId.toString(),
    );
    return new Set(unidades.map((u) => u.rol));
  }

  private legible(
    carpeta: CarpetaDocumentoDocument,
    tipos: ReadonlySet<TipoResidente>,
    mapa: MapaCarpetas,
  ): boolean {
    return residentePuedeLeer(carpeta, tipos, mapa);
  }

  /** Folders under `parent` (or the root) the caller may read, over confirmed files only. */
  async listarCarpetas(
    filtros: ListarCarpetasDto,
    user: IRequestUser,
  ): Promise<CarpetaAdministracionPortal[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [tipos, mapa, estadisticas] = await Promise.all([
      this.tiposDe(user, copropiedadId),
      this.carpetas.cargarMapa(copropiedadId),
      this.carpetas.estadisticas(copropiedadId),
    ]);
    return this.carpetas
      .hijas(mapa, filtros.parent ?? null)
      .filter((c) => this.legible(c, tipos, mapa))
      .map((c) =>
        toCarpetaPortal(
          c,
          estadisticas.get(c._id.toString()) ?? {
            archivos: 0,
            tamanoBytes: 0,
            actualizado: (
              (c as unknown as { updatedAt?: Date }).updatedAt ?? new Date()
            ).toISOString(),
          },
        ),
      );
  }

  /** Deep-link by slug; a folder the caller may not read is a 404, like a missing one. */
  async carpetaPorSlug(
    slug: string,
    user: IRequestUser,
  ): Promise<CarpetaAdministracionPortal> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [tipos, mapa, estadisticas] = await Promise.all([
      this.tiposDe(user, copropiedadId),
      this.carpetas.cargarMapa(copropiedadId),
      this.carpetas.estadisticas(copropiedadId),
    ]);
    const carpeta = this.visible(mapa, slug, tipos);
    return toCarpetaPortal(
      carpeta,
      estadisticas.get(carpeta._id.toString()) ?? {
        archivos: 0,
        tamanoBytes: 0,
        actualizado: (
          (carpeta as unknown as { updatedAt?: Date }).updatedAt ?? new Date()
        ).toISOString(),
      },
    );
  }

  private visible(
    mapa: MapaCarpetas,
    slug: string,
    tipos: ReadonlySet<TipoResidente>,
  ): CarpetaDocumentoDocument {
    const carpeta = [...mapa.values()].find((c) => c.slug === slug);
    if (!carpeta || !this.legible(carpeta, tipos, mapa)) {
      throw new NotFoundException(`Carpeta '${slug}' no encontrada`);
    }
    return carpeta;
  }

  /**
   * Breadcrumb root -> folder. Ancestors the resident may not read are left out,
   * so their names never leak through the trail.
   */
  async ruta(
    id: string,
    user: IRequestUser,
  ): Promise<RutaCarpetaAdministracion[]> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Carpeta ${id} no encontrada`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [tipos, mapa] = await Promise.all([
      this.tiposDe(user, copropiedadId),
      this.carpetas.cargarMapa(copropiedadId),
    ]);
    const carpeta = mapa.get(id);
    if (!carpeta || !this.legible(carpeta, tipos, mapa)) {
      throw new NotFoundException(`Carpeta ${id} no encontrada`);
    }
    return this.carpetas.rutaItems(id, mapa, (c) =>
      this.legible(c, tipos, mapa),
    );
  }

  /** Confirmed files in the folders the caller may read; an unreadable folder filter is a 404. */
  async listarDocumentos(
    filtros: ListarDocumentosDto,
    user: IRequestUser,
  ): Promise<ArchivoAdministracion[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [tipos, mapa] = await Promise.all([
      this.tiposDe(user, copropiedadId),
      this.carpetas.cargarMapa(copropiedadId),
    ]);

    let carpetaIds: Types.ObjectId[];
    if (filtros.carpeta && filtros.carpeta !== 'todos') {
      carpetaIds = [this.visible(mapa, filtros.carpeta, tipos)._id];
    } else {
      carpetaIds = [...mapa.values()]
        .filter((c) => this.legible(c, tipos, mapa))
        .map((c) => c._id);
    }

    const filtro: Record<string, unknown> = {
      copropiedadId,
      estado: 'listo',
      carpetaId: { $in: carpetaIds },
    };
    if (filtros.q) filtro.nombre = new RegExp(escapeRegex(filtros.q), 'i');

    const archivos = await this.archivos
      .find(filtro)
      .sort({ updatedAt: -1 })
      .exec();
    return archivos.map((a) => {
      const id = a.carpetaId.toString();
      return toArchivo(
        a,
        mapa.get(id)?.slug ?? '',
        this.carpetas.rutaTexto(id, mapa, (c) => this.legible(c, tipos, mapa)),
      );
    });
  }

  /**
   * Short-lived signed read URL. The URL is requested ONLY after the file is
   * known to exist in this coproperty, to be confirmed, and to sit in a folder
   * the caller may read; every other case is a 404.
   */
  async descargar(id: string, user: IRequestUser): Promise<DescargaArchivo> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Documento ${id} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [tipos, mapa] = await Promise.all([
      this.tiposDe(user, copropiedadId),
      this.carpetas.cargarMapa(copropiedadId),
    ]);
    const archivo = await this.archivos
      .findOne({ _id: id, copropiedadId, estado: 'listo' })
      .exec();
    const carpeta = archivo
      ? mapa.get(archivo.carpetaId.toString())
      : undefined;
    if (
      !archivo ||
      !archivo.rutaAlmacenamiento ||
      !carpeta ||
      !this.legible(carpeta, tipos, mapa)
    ) {
      throw new NotFoundException(`Documento ${id} no encontrado`);
    }
    const url = await this.almacen.firmarLectura(archivo.rutaAlmacenamiento);
    return { url, nombre: archivo.nombre };
  }
}

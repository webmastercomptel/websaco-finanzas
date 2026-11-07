// src/modules/documentos/documentos.service.ts
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
import { escapeRegex } from '../../common/utils/query.utils';
import type {
  ArchivoAdministracion,
  DescargaArchivo,
  EstadisticasArchivos,
  SubidaArchivoIniciada,
} from '../../contracts';
import {
  ArchivoDocumento,
  type ArchivoDocumentoDocument,
} from '../../database/schemas/administracion/documento-archivo.schema';
import {
  ConsecutivoAdministracion,
  type ConsecutivoAdministracionDocument,
} from '../../database/schemas/administracion/consecutivo-administracion.schema';
import type { CarpetaDocumentoDocument } from '../../database/schemas/administracion/documento-carpeta.schema';
import { CarpetasService, type MapaCarpetas } from './carpetas.service';
import { type ActorDocumentos } from './documentos-acceso';
import { DocumentosActorService } from './documentos-actor.service';
import {
  DocumentosAlmacenService,
  rutaParaArchivo,
} from './documentos-almacen.service';
import { DocumentosNotificacionesService } from './documentos-notificaciones.service';
import { tipoDeArchivo, toArchivo } from './documentos.mapper';
import type { ActualizarDocumentoDto } from './dto/actualizar-documento.dto';
import type { CrearDocumentoDto } from './dto/guardar-documento.dto';
import type { ListarDocumentosDto } from './dto/listar-documentos.dto';

/** Largest file that may be declared (and, at confirmation, that may really exist). */
export const TAMANO_MAXIMO_DOCUMENTO_BYTES = 200 * 1024 * 1024;

/** Storage quota shown on the screen's usage bar (display only, not enforced). */
export const CUOTA_ALMACENAMIENTO_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * The library's files of the ACTIVE coproperty, for staff. The tenant always
 * comes from the request context; every lookup and write filters by id AND
 * `copropiedadId`, so an id of another building is a plain 404.
 *
 * Who may do what (the route enforces the CASL ability; the folder rules decide
 * WHICH folders): reading needs `read Documento` + a rule that reads the folder;
 * uploading and editing a file needs `create Documento` + a rule that WRITES the
 * folder; deleting needs `manage Documento`. A `gestionar` holder bypasses the
 * folder rules.
 *
 * Uploads are two steps so no bytes pass through this API: `iniciar` registers
 * the file as `pendiente` and signs a write URL; the browser PUTs, then
 * `confirmar` checks the object really exists before flipping it to `listo`.
 */
@Injectable()
export class DocumentosService {
  private readonly logger = new Logger(DocumentosService.name);

  constructor(
    @InjectModel(ArchivoDocumento.name)
    private readonly archivos: Model<ArchivoDocumentoDocument>,
    @InjectModel(ConsecutivoAdministracion.name)
    private readonly consecutivos: Model<ConsecutivoAdministracionDocument>,
    private readonly tenant: TenantContextService,
    private readonly carpetas: CarpetasService,
    private readonly actores: DocumentosActorService,
    private readonly almacen: DocumentosAlmacenService,
    private readonly notificaciones: DocumentosNotificacionesService,
  ) {}

  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Documento ${id} no encontrado`);
    }
  }

  /** The folder a file sits in, from the map; a dangling folder means no access. */
  private carpetaDe(
    archivo: ArchivoDocumentoDocument,
    mapa: MapaCarpetas,
  ): CarpetaDocumentoDocument | undefined {
    return mapa.get(archivo.carpetaId.toString());
  }

  private exigirAcceso(
    carpeta: CarpetaDocumentoDocument | undefined,
    actor: ActorDocumentos,
    mapa: MapaCarpetas,
    necesita: 'leer' | 'escribir',
  ): void {
    const acceso = carpeta
      ? this.carpetas.accesoDe(carpeta, actor, mapa)
      : { puedeLeer: false, puedeEscribir: false };
    const ok = necesita === 'leer' ? acceso.puedeLeer : acceso.puedeEscribir;
    if (!ok) {
      throw new ForbiddenException(
        necesita === 'leer'
          ? 'No tenés acceso a este documento'
          : 'No tenés permiso para modificar este documento',
      );
    }
  }

  private aContrato(
    archivo: ArchivoDocumentoDocument,
    mapa: MapaCarpetas,
  ): ArchivoAdministracion {
    const id = archivo.carpetaId.toString();
    return toArchivo(
      archivo,
      mapa.get(id)?.slug ?? '',
      this.carpetas.rutaTexto(id, mapa),
    );
  }

  /**
   * Confirmed files in the folders the caller may read (pending uploads are
   * never listed). A specific folder the caller cannot read is a 403; with no
   * folder given the result is limited to the readable ones.
   */
  async listar(
    filtros: ListarDocumentosDto,
    user: IRequestUser,
  ): Promise<ArchivoAdministracion[]> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa] = await Promise.all([
      this.actores.deSolicitud(user),
      this.carpetas.cargarMapa(copropiedadId),
    ]);

    let carpetaIds: Types.ObjectId[];
    if (filtros.carpeta && filtros.carpeta !== 'todos') {
      const carpeta = this.carpetas.resolverPorSlug(mapa, filtros.carpeta);
      if (!this.carpetas.accesoDe(carpeta, actor, mapa).puedeLeer) {
        throw new ForbiddenException('No tenés acceso a esta carpeta');
      }
      carpetaIds = [carpeta._id];
    } else {
      carpetaIds = [...mapa.values()]
        .filter((c) => this.carpetas.accesoDe(c, actor, mapa).puedeLeer)
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
    return archivos.map((a) => this.aContrato(a, mapa));
  }

  /**
   * Library usage of the coproperty (confirmed files only), counted over the
   * folders the caller may read — counts and sizes of a private folder are
   * information about it too. The quota is the coproperty's.
   */
  async estadisticas(user: IRequestUser): Promise<EstadisticasArchivos> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa] = await Promise.all([
      this.actores.deSolicitud(user),
      this.carpetas.cargarMapa(copropiedadId),
    ]);
    const carpetaIds = [...mapa.values()]
      .filter((c) => this.carpetas.accesoDe(c, actor, mapa).puedeLeer)
      .map((c) => c._id);
    const [fila] = await this.archivos
      .aggregate<{ total: number; usado: number }>([
        {
          $match: {
            copropiedadId,
            estado: 'listo',
            carpetaId: { $in: carpetaIds },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            usado: { $sum: '$tamanoBytes' },
          },
        },
      ])
      .exec();
    return {
      totalArchivos: fila?.total ?? 0,
      espacioUsadoBytes: fila?.usado ?? 0,
      espacioTotalBytes: CUOTA_ALMACENAMIENTO_BYTES,
    };
  }

  /**
   * Step 1: registers the file as `pendiente` (the backend owns the storage
   * path) and signs a write URL pinned to the declared content type. Folder
   * existence and permission come first, so nobody learns the limits of a
   * folder they cannot write to.
   */
  async iniciar(
    dto: CrearDocumentoDto,
    user: IRequestUser,
  ): Promise<SubidaArchivoIniciada> {
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa] = await Promise.all([
      this.actores.deSolicitud(user),
      this.carpetas.cargarMapa(copropiedadId),
    ]);
    const carpeta = this.carpetas.resolverPorSlug(mapa, dto.carpeta);
    if (!this.carpetas.accesoDe(carpeta, actor, mapa).puedeEscribir) {
      throw new ForbiddenException(
        'No tenés permiso para subir archivos a esta carpeta',
      );
    }
    if (dto.tamanoBytes > TAMANO_MAXIMO_DOCUMENTO_BYTES) {
      throw new BadRequestException('El archivo supera el límite de 200 MB');
    }

    const codigo = await siguienteCodigo(this.consecutivos, 'DOC');
    const rutaAlmacenamiento = rutaParaArchivo(
      copropiedadId.toString(),
      dto.nombre,
    );
    const creado = await new this.archivos({
      copropiedadId,
      carpetaId: carpeta._id,
      codigo,
      nombre: dto.nombre,
      mimeType: dto.mimeType,
      tipo: tipoDeArchivo(dto.mimeType, dto.nombre),
      categoria: dto.categoria ?? '',
      rutaAlmacenamiento,
      estado: 'pendiente',
      tamanoBytes: dto.tamanoBytes,
      autorNombre: user.nombre ?? '',
      destacado: false,
      etiquetas: dto.etiquetas ?? [],
      subidoPorId:
        user.accountId && Types.ObjectId.isValid(user.accountId)
          ? new Types.ObjectId(user.accountId)
          : null,
    }).save();

    const uploadUrl = await this.almacen.firmarSubida(
      rutaAlmacenamiento,
      dto.mimeType,
    );
    return { documento: this.aContrato(creado, mapa), uploadUrl };
  }

  /**
   * Step 2: after the browser's PUT, verifies the object exists, records its real
   * size and flips the record to `listo`. The still-`pendiente` condition lives
   * inside the update filter, so two concurrent confirmations cannot both win
   * (and cannot both notify). An object over the limit is removed with its record.
   */
  async confirmar(
    id: string,
    user: IRequestUser,
  ): Promise<ArchivoAdministracion> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa] = await Promise.all([
      this.actores.deSolicitud(user),
      this.carpetas.cargarMapa(copropiedadId),
    ]);
    const archivo = await this.archivos
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!archivo) throw new NotFoundException(`Documento ${id} no encontrado`);
    this.exigirAcceso(this.carpetaDe(archivo, mapa), actor, mapa, 'escribir');
    if (archivo.estado !== 'pendiente') {
      throw new ConflictException('El documento ya fue confirmado');
    }
    if (!archivo.rutaAlmacenamiento) {
      throw new ConflictException('El documento no tiene archivo');
    }

    let tamanoReal: number;
    try {
      tamanoReal = await this.almacen.tamanoReal(archivo.rutaAlmacenamiento);
    } catch {
      throw new BadRequestException('El archivo no se subió correctamente');
    }
    if (tamanoReal > TAMANO_MAXIMO_DOCUMENTO_BYTES) {
      // Record first, then the object: an object left behind is only an
      // orphan, a record without its object would be a broken download.
      const borrado = await this.archivos
        .deleteOne({ _id: id, copropiedadId, estado: 'pendiente' })
        .exec();
      if (borrado.deletedCount === 1) {
        await this.almacen.eliminar(archivo.rutaAlmacenamiento);
      }
      throw new BadRequestException('El archivo supera el límite de 200 MB');
    }

    const confirmado = await this.archivos
      .findOneAndUpdate(
        { _id: id, copropiedadId, estado: 'pendiente' },
        { $set: { estado: 'listo', tamanoBytes: tamanoReal } },
        { new: true },
      )
      .exec();
    if (!confirmado) {
      throw new ConflictException('El documento ya fue confirmado');
    }

    await this.notificaciones.notificarNuevo(
      confirmado,
      mapa,
      this.carpetas.rutaTexto(confirmado.carpetaId.toString(), mapa),
      copropiedadId,
    );
    return this.aContrato(confirmado, mapa);
  }

  /** Signs a short-lived read URL. Only for a confirmed file in a folder the caller may read. */
  async descargar(id: string, user: IRequestUser): Promise<DescargaArchivo> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa] = await Promise.all([
      this.actores.deSolicitud(user),
      this.carpetas.cargarMapa(copropiedadId),
    ]);
    const archivo = await this.archivos
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!archivo) throw new NotFoundException(`Documento ${id} no encontrado`);
    this.exigirAcceso(this.carpetaDe(archivo, mapa), actor, mapa, 'leer');
    if (!archivo.rutaAlmacenamiento || archivo.estado !== 'listo') {
      throw new ConflictException('El documento no tiene archivo');
    }
    const url = await this.almacen.firmarLectura(archivo.rutaAlmacenamiento);
    return { url, nombre: archivo.nombre };
  }

  /**
   * Edits featured flag, tags and/or folder. Needs write access on the current
   * folder and, when moving, on the target folder too.
   */
  async actualizar(
    id: string,
    dto: ActualizarDocumentoDto,
    user: IRequestUser,
  ): Promise<ArchivoAdministracion> {
    this.validarId(id);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const [actor, mapa] = await Promise.all([
      this.actores.deSolicitud(user),
      this.carpetas.cargarMapa(copropiedadId),
    ]);
    const existente = await this.archivos
      .findOne({ _id: id, copropiedadId })
      .exec();
    if (!existente)
      throw new NotFoundException(`Documento ${id} no encontrado`);
    this.exigirAcceso(this.carpetaDe(existente, mapa), actor, mapa, 'escribir');

    const cambios: Record<string, unknown> = {};
    if (dto.destacado !== undefined) cambios.destacado = dto.destacado;
    if (dto.etiquetas !== undefined) cambios.etiquetas = dto.etiquetas;
    if (dto.carpeta !== undefined) {
      const destino = this.carpetas.resolverPorSlug(mapa, dto.carpeta);
      this.exigirAcceso(destino, actor, mapa, 'escribir');
      cambios.carpetaId = destino._id;
    }

    const actualizado = await this.archivos
      .findOneAndUpdate(
        { _id: id, copropiedadId },
        { $set: cambios },
        { new: true },
      )
      .exec();
    if (!actualizado)
      throw new NotFoundException(`Documento ${id} no encontrado`);
    return this.aContrato(actualizado, mapa);
  }

  /**
   * Deletes a file: its record first, then its Storage object (best-effort). The
   * route requires `manage Documento`; there is no per-folder delete right.
   * Record-first on purpose: a leftover object is an orphan nobody can reach, a
   * leftover record would be a download that fails.
   */
  async eliminar(id: string, user: IRequestUser): Promise<{ id: string }> {
    this.validarId(id);
    if (!(await this.actores.deSolicitud(user)).gestiona) {
      throw new ForbiddenException(
        'Solo quien gestiona documentos puede eliminarlos',
      );
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const archivo = await this.archivos
      .findOneAndDelete({ _id: id, copropiedadId })
      .exec();
    if (!archivo) throw new NotFoundException(`Documento ${id} no encontrado`);
    if (archivo.rutaAlmacenamiento) {
      const borrado = await this.almacen.eliminar(archivo.rutaAlmacenamiento);
      if (!borrado) {
        this.logger.warn(
          `El documento ${id} se borró pero su objeto ${archivo.rutaAlmacenamiento} quedó en Storage.`,
        );
      }
    }
    return { id };
  }
}

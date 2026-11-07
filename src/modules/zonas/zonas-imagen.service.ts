// src/modules/zonas/zonas-imagen.service.ts
import { randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GCS_BUCKET } from '../../common/storage/storage.constants';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { ImagenZonaSubidaIniciada, ZonaComun } from '../../contracts';
import {
  Zona,
  type ZonaDocument,
} from '../../database/schemas/administracion/zona.schema';
import type { IniciarSubidaImagenZonaDto } from './dto/iniciar-subida-imagen-zona.dto';
import { toZonaComun } from './zonas.mapper';

/**
 * Largest cover image a zone may be: checked on the declaration and again on
 * the real object at `confirmar`. A cover picture has no reason to be big.
 */
export const TAMANO_MAXIMO_IMAGEN_BYTES = 10 * 1024 * 1024;

/**
 * Raster formats only. SVG is excluded: it is a document that can carry script,
 * and these objects are served from the bucket that holds Finanzas documents.
 */
export const TIPOS_IMAGEN_ZONA = ['image/png', 'image/jpeg', 'image/webp'];

/** How long the signed upload URL works: one upload attempt, not a standing credential. */
const VIGENCIA_URL_SUBIDA_MS = 15 * 60 * 1000;

/**
 * How long a signed READ URL of a cover image works. Long enough for a page
 * that stays open; listings mint a fresh one on every load.
 */
const VIGENCIA_URL_LECTURA_MS = 60 * 60 * 1000;

const PREFIJO_ZONAS = 'zonas/';

/**
 * Cover image of a zone, uploaded straight from the browser to the storage
 * bucket in two steps so no bytes pass through this API:
 *
 * 1. `iniciar`: signs a write URL pinned to the declared content type and hands
 *    back the object path the backend chose. Nothing is persisted yet: the zone
 *    keeps its current image until step 2.
 * 2. The browser PUTs the file, then calls `confirmar`: the backend checks the
 *    path is one it generated for THIS zone, that the object really exists,
 *    is a png/jpeg/webp within the size limit (otherwise it is deleted), and
 *    only then stores the path in `imagenRuta`.
 *
 * The object is NEVER made public: the shared bucket also holds the Finanzas
 * PDFs and must stay uniform-access with public access prevented. Readers get
 * a short-lived signed URL (`urlLectura`), minted every time a zone is mapped.
 */
@Injectable()
export class ZonasImagenService {
  constructor(
    @InjectModel(Zona.name)
    private readonly zonas: Model<ZonaDocument>,
    @Inject(GCS_BUCKET) private readonly bucket: Bucket,
    private readonly tenant: TenantContextService,
  ) {}

  private validarId(id: string): void {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`Zona común ${id} no encontrada`);
    }
  }

  /** Step 1. Existence first, so nobody learns the limits of a zone they cannot reach. */
  async iniciar(
    zonaId: string,
    dto: IniciarSubidaImagenZonaDto,
  ): Promise<ImagenZonaSubidaIniciada> {
    this.validarId(zonaId);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const zona = await this.zonas
      .findOne({ _id: zonaId, copropiedadId })
      .select('_id')
      .exec();
    if (!zona) {
      throw new NotFoundException(`Zona común ${zonaId} no encontrada`);
    }
    if (!TIPOS_IMAGEN_ZONA.includes(dto.mimeType)) {
      throw new BadRequestException('La imagen debe ser PNG, JPEG o WebP');
    }
    if (dto.tamanoBytes > TAMANO_MAXIMO_IMAGEN_BYTES) {
      throw new BadRequestException('La imagen supera el límite de 10 MB');
    }

    const nombreSeguro = dto.nombre.replace(/[^\w.-]+/g, '_');
    const storagePath = `zonas/${copropiedadId.toString()}/${zonaId}/${randomUUID()}-${nombreSeguro}`;

    const [uploadUrl] = await this.bucket.file(storagePath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + VIGENCIA_URL_SUBIDA_MS,
      contentType: dto.mimeType,
    });

    return { uploadUrl, storagePath };
  }

  /** Step 2. A client-supplied path is never trusted: it must carry this tenant and zone. */
  async confirmar(zonaId: string, storagePath: string): Promise<ZonaComun> {
    this.validarId(zonaId);
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const zona = await this.zonas
      .findOne({ _id: zonaId, copropiedadId })
      .select('_id')
      .exec();
    if (!zona) {
      throw new NotFoundException(`Zona común ${zonaId} no encontrada`);
    }

    // SECURITY: only a path of the exact shape `iniciar` generates for this
    // tenant and zone; otherwise a client could point the zone at somebody
    // else's object and have it served.
    const prefijoEsperado = `zonas/${copropiedadId.toString()}/${zonaId}/`;
    if (!storagePath.startsWith(prefijoEsperado)) {
      throw new BadRequestException('storagePath inválido para esta zona');
    }

    if (storagePath.includes('..')) {
      throw new BadRequestException('storagePath inválido para esta zona');
    }

    const archivo = this.bucket.file(storagePath);
    let metadata: { size?: string | number; contentType?: string };
    try {
      [metadata] = await archivo.getMetadata();
    } catch {
      throw new BadRequestException('El archivo no se subió correctamente');
    }
    const tamano = Number(metadata.size ?? 0);
    const tipoValido = TIPOS_IMAGEN_ZONA.includes(metadata.contentType ?? '');
    if (tamano > TAMANO_MAXIMO_IMAGEN_BYTES || !tipoValido) {
      await archivo.delete().catch(() => undefined);
      throw new BadRequestException(
        tipoValido
          ? 'La imagen supera el límite de 10 MB'
          : 'La imagen debe ser PNG, JPEG o WebP',
      );
    }

    const documento = await this.zonas
      .findOneAndUpdate(
        { _id: zonaId, copropiedadId },
        { $set: { imagenRuta: storagePath, imagenUrl: null } },
        { new: true },
      )
      .exec();
    if (!documento) {
      throw new NotFoundException(`Zona común ${zonaId} no encontrada`);
    }
    return toZonaComun(documento, await this.urlLectura(storagePath));
  }

  /** Short-lived signed read URL of an uploaded zone image (only under `zonas/`). */
  async urlLectura(ruta: string): Promise<string | null> {
    if (!ruta.startsWith(PREFIJO_ZONAS) || ruta.includes('..')) return null;
    try {
      const [url] = await this.bucket.file(ruta).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + VIGENCIA_URL_LECTURA_MS,
      });
      return url;
    } catch {
      // A zone without its picture is better than a listing that fails.
      return null;
    }
  }
}

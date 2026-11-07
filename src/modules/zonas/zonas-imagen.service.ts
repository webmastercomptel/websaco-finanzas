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
 * Largest cover image a zone may declare. Much smaller than the 200 MB of a PQR
 * attachment: a cover picture has no reason to be big.
 */
export const TAMANO_MAXIMO_IMAGEN_BYTES = 10 * 1024 * 1024;

/** How long the signed upload URL works: one upload attempt, not a standing credential. */
const VIGENCIA_URL_SUBIDA_MS = 15 * 60 * 1000;

/**
 * Cover image of a zone, uploaded straight from the browser to the storage
 * bucket in two steps so no bytes pass through this API:
 *
 * 1. `iniciar`: signs a write URL pinned to the declared content type and hands
 *    back the object path the backend chose. Nothing is persisted yet: the zone
 *    keeps its current image until step 2.
 * 2. The browser PUTs the file, then calls `confirmar`: the backend checks the
 *    path is one it generated for THIS zone, that the object really exists,
 *    makes it public and only then overwrites `imagenUrl`.
 *
 * The object is made public because the URL goes straight into an `<img>` for
 * every resident; that is how the system this replaces worked, and it needs a
 * bucket that allows per-object public access.
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
    // The object is published as-is, so only images may be signed for.
    if (!dto.mimeType.startsWith('image/')) {
      throw new BadRequestException('El archivo debe ser una imagen');
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
    // else's object and have it made public.
    const prefijoEsperado = `zonas/${copropiedadId.toString()}/${zonaId}/`;
    if (!storagePath.startsWith(prefijoEsperado)) {
      throw new BadRequestException('storagePath inválido para esta zona');
    }

    const archivo = this.bucket.file(storagePath);
    try {
      await archivo.getMetadata();
    } catch {
      throw new BadRequestException('El archivo no se subió correctamente');
    }
    await archivo.makePublic();

    const documento = await this.zonas
      .findOneAndUpdate(
        { _id: zonaId, copropiedadId },
        { $set: { imagenUrl: archivo.publicUrl() } },
        { new: true },
      )
      .exec();
    if (!documento) {
      throw new NotFoundException(`Zona común ${zonaId} no encontrada`);
    }
    return toZonaComun(documento);
  }
}

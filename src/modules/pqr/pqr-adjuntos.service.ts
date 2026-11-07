import { randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { GCS_BUCKET } from '../../common/storage/storage.constants';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import type {
  Pqr as PqrContrato,
  PqrAdjuntoSubidaIniciada,
} from '../../contracts';
import {
  Pqr,
  type PqrDocument,
} from '../../database/schemas/administracion/pqr.schema';
import type { CrearAdjuntoPqrDto } from './dto/guardar-adjunto.dto';
import { filtroPqr, poblarTecnico } from './pqr-consultas';
import { toPqr } from './pqr.mapper';

/** Largest file a PQR attachment may declare. */
export const TAMANO_MAXIMO_ADJUNTO_BYTES = 200 * 1024 * 1024;

/** How long the signed upload URL works: one upload attempt, not a standing credential. */
const VIGENCIA_URL_SUBIDA_MS = 15 * 60 * 1000;

/** The attachment's `tipo` tag, derived from its MIME type. */
const tipoDeAdjunto = (mime: string): string => {
  if (mime.startsWith('image/')) return 'imagen';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('wordprocessingml') || mime.includes('msword')) {
    return 'docx';
  }
  if (mime.includes('spreadsheetml') || mime.includes('excel')) return 'xlsx';
  return 'archivo';
};

/**
 * Evidence files of a PQR, uploaded straight from the browser to the storage
 * bucket in two steps so no bytes ever pass through this API:
 *
 * 1. `iniciar`: registers the attachment as `pendiente` (the backend owns the
 *    object path) and signs a write URL pinned to the declared content type.
 * 2. The browser PUTs the file, then calls `confirmar`: the backend checks the
 *    object really exists before flipping that one attachment to `listo`. The
 *    client's "I uploaded it" is never trusted on its own.
 *
 * Who may attach is decided by the route, as everywhere in this module: staff
 * (`manage` Pqr) on any PQR of the coproperty, a resident only on one they
 * filed (the `...Residente` entry points narrow the filter by author, so
 * somebody else's PQR is a 404).
 */
@Injectable()
export class PqrAdjuntosService {
  constructor(
    @InjectModel(Pqr.name)
    private readonly pqrs: Model<PqrDocument>,
    @Inject(GCS_BUCKET) private readonly bucket: Bucket,
    private readonly tenant: TenantContextService,
  ) {}

  private cuentaDelResidente(user: IRequestUser): Types.ObjectId {
    if (!user.accountId || !Types.ObjectId.isValid(user.accountId)) {
      throw new ForbiddenException('No se pudo identificar tu cuenta');
    }
    return new Types.ObjectId(user.accountId);
  }

  private async iniciar(
    id: string,
    dto: CrearAdjuntoPqrDto,
    soloDe?: Types.ObjectId,
  ): Promise<PqrAdjuntoSubidaIniciada> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`PQR ${id} no encontrada`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro = filtroPqr(id, copropiedadId, soloDe);

    // Existence and access first, so nobody learns the size limit (or anything
    // else) about a PQR they cannot reach.
    const existente = await this.pqrs.findOne(filtro).select('_id').exec();
    if (!existente) throw new NotFoundException(`PQR ${id} no encontrada`);

    if (dto.tamanoBytes > TAMANO_MAXIMO_ADJUNTO_BYTES) {
      throw new BadRequestException('El archivo supera el límite de 200 MB');
    }

    const nombreSeguro = dto.nombre.replace(/[^\w.-]+/g, '_');
    const rutaAlmacenamiento = `pqrs/${copropiedadId.toString()}/${id}/${randomUUID()}-${nombreSeguro}`;

    const actualizada = await this.pqrs
      .findOneAndUpdate(
        filtro,
        {
          $push: {
            archivosAdjuntos: {
              tipo: tipoDeAdjunto(dto.mimeType),
              nombre: dto.nombre,
              url: null,
              rutaAlmacenamiento,
              estado: 'pendiente',
            },
          },
        },
        { new: true },
      )
      .populate(poblarTecnico(copropiedadId))
      .exec();
    if (!actualizada) throw new NotFoundException(`PQR ${id} no encontrada`);

    const registrado = actualizada.archivosAdjuntos.find(
      (adjunto) => adjunto.rutaAlmacenamiento === rutaAlmacenamiento,
    );
    if (!registrado) {
      throw new NotFoundException('No se pudo registrar el adjunto');
    }

    const [uploadUrl] = await this.bucket
      .file(rutaAlmacenamiento)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + VIGENCIA_URL_SUBIDA_MS,
        contentType: dto.mimeType,
      });

    return {
      pqr: toPqr(actualizada),
      uploadUrl,
      attachmentId: registrado._id.toString(),
    };
  }

  private async confirmar(
    id: string,
    adjuntoId: string,
    soloDe?: Types.ObjectId,
  ): Promise<PqrContrato> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException(`PQR ${id} no encontrada`);
    }
    if (!Types.ObjectId.isValid(adjuntoId)) {
      throw new NotFoundException(`Adjunto ${adjuntoId} no encontrado`);
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const filtro = filtroPqr(id, copropiedadId, soloDe);

    const pqr = await this.pqrs.findOne(filtro).exec();
    if (!pqr) throw new NotFoundException(`PQR ${id} no encontrada`);

    const adjunto = pqr.archivosAdjuntos.find(
      (a) => a._id.toString() === adjuntoId,
    );
    if (!adjunto) {
      throw new NotFoundException(`Adjunto ${adjuntoId} no encontrado`);
    }
    if (adjunto.estado !== 'pendiente') {
      throw new ConflictException('El adjunto ya fue confirmado');
    }
    if (!adjunto.rutaAlmacenamiento) {
      throw new ConflictException('El adjunto no tiene archivo');
    }

    try {
      await this.bucket.file(adjunto.rutaAlmacenamiento).getMetadata();
    } catch {
      throw new BadRequestException('El archivo no se subió correctamente');
    }

    // The still-`pendiente` condition lives inside the filter: two concurrent
    // confirmations cannot both win, and the positional `$` touches only the
    // matched attachment, never its siblings.
    const actualizada = await this.pqrs
      .findOneAndUpdate(
        {
          ...filtro,
          archivosAdjuntos: {
            $elemMatch: {
              _id: new Types.ObjectId(adjuntoId),
              estado: 'pendiente',
            },
          },
        },
        { $set: { 'archivosAdjuntos.$.estado': 'listo' } },
        { new: true },
      )
      .populate(poblarTecnico(copropiedadId))
      .exec();
    if (!actualizada) {
      throw new ConflictException('El adjunto ya fue confirmado');
    }
    return toPqr(actualizada);
  }

  /** Step 1 on any PQR of the coproperty (staff). */
  iniciarSubida(
    id: string,
    dto: CrearAdjuntoPqrDto,
  ): Promise<PqrAdjuntoSubidaIniciada> {
    return this.iniciar(id, dto);
  }

  /** Step 2 on any PQR of the coproperty (staff). */
  confirmarSubida(id: string, adjuntoId: string): Promise<PqrContrato> {
    return this.confirmar(id, adjuntoId);
  }

  /** Step 1 on a PQR the resident filed; anybody else's is a 404. */
  async iniciarSubidaResidente(
    id: string,
    dto: CrearAdjuntoPqrDto,
    user: IRequestUser,
  ): Promise<PqrAdjuntoSubidaIniciada> {
    return await this.iniciar(id, dto, this.cuentaDelResidente(user));
  }

  /** Step 2 on a PQR the resident filed; anybody else's is a 404. */
  async confirmarSubidaResidente(
    id: string,
    adjuntoId: string,
    user: IRequestUser,
  ): Promise<PqrContrato> {
    return await this.confirmar(id, adjuntoId, this.cuentaDelResidente(user));
  }
}

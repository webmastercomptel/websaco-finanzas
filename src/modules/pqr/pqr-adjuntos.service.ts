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
  DescargaArchivo,
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

/**
 * Largest file a PQR attachment may be: evidence (photos, a scanned letter),
 * not an archive. Checked on the declaration AND on the real object at
 * `confirmar`, because the signed URL does not bound what the browser PUTs.
 */
export const TAMANO_MAXIMO_ADJUNTO_BYTES = 25 * 1024 * 1024;

/** Attachments one PQR may hold, pending ones included (they occupy storage too). */
export const MAXIMO_ADJUNTOS_POR_PQR = 10;

/** How long a signed URL works: one upload or one download, not a standing credential. */
export const VIGENCIA_URL_ADJUNTO_MS = 15 * 60 * 1000;

/** The ONLY Storage prefix this module touches. */
export const PREFIJO_ADJUNTOS_PQR = 'pqrs/';

/** Whether a stored path lies inside this module's prefix (and is not the bare prefix). */
export const esRutaDeAdjuntoPqr = (ruta: string | null): ruta is string =>
  !!ruta &&
  ruta.startsWith(PREFIJO_ADJUNTOS_PQR) &&
  ruta.length > PREFIJO_ADJUNTOS_PQR.length &&
  !ruta.includes('..');

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
      throw new BadRequestException('El archivo supera el límite de 25 MB');
    }

    const nombreSeguro = dto.nombre.replace(/[^\w.-]+/g, '_');
    const rutaAlmacenamiento = `pqrs/${copropiedadId.toString()}/${id}/${randomUUID()}-${nombreSeguro}`;

    // The cap lives in the filter: concurrent uploads cannot overshoot it.
    const actualizada = await this.pqrs
      .findOneAndUpdate(
        {
          ...filtro,
          [`archivosAdjuntos.${MAXIMO_ADJUNTOS_POR_PQR - 1}`]: {
            $exists: false,
          },
        },
        {
          $push: {
            archivosAdjuntos: {
              creadoEn: new Date(),
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
    if (!actualizada) {
      // It existed a moment ago, so what failed is the cap.
      throw new ConflictException(
        `Una PQR admite como máximo ${MAXIMO_ADJUNTOS_POR_PQR} adjuntos`,
      );
    }

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
        expires: Date.now() + VIGENCIA_URL_ADJUNTO_MS,
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

    let tamanoReal: number;
    try {
      const [metadata] = await this.bucket
        .file(adjunto.rutaAlmacenamiento)
        .getMetadata();
      tamanoReal = Number(metadata.size ?? 0);
    } catch {
      throw new BadRequestException('El archivo no se subió correctamente');
    }
    if (tamanoReal > TAMANO_MAXIMO_ADJUNTO_BYTES) {
      // Entry first, then the object: an object left behind is only an orphan,
      // an entry without its object would be a broken attachment.
      const quitado = await this.pqrs
        .updateOne(filtro, {
          $pull: {
            archivosAdjuntos: { _id: adjunto._id, estado: 'pendiente' },
          },
        })
        .exec();
      if (quitado.modifiedCount === 1) {
        await this.borrarObjeto(adjunto.rutaAlmacenamiento);
      }
      throw new BadRequestException('El archivo supera el límite de 25 MB');
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

  /** Best-effort delete inside `pqrs/` only; never throws. */
  private async borrarObjeto(ruta: string): Promise<void> {
    if (!esRutaDeAdjuntoPqr(ruta)) return;
    await this.bucket
      .file(ruta)
      .delete()
      .catch(() => undefined);
  }

  /**
   * A short-lived signed read URL for one verified (`listo`) attachment. The
   * stored `url` stays null: a link is minted per request, for whoever the
   * route already authorized, and expires in minutes.
   */
  private async descargar(
    id: string,
    adjuntoId: string,
    soloDe?: Types.ObjectId,
  ): Promise<DescargaArchivo> {
    const noEncontrado = () =>
      new NotFoundException(`Adjunto ${adjuntoId} no encontrado`);
    if (!Types.ObjectId.isValid(id) || !Types.ObjectId.isValid(adjuntoId)) {
      throw noEncontrado();
    }
    const copropiedadId = this.tenant.resolveCoPropertyId();
    const pqr = await this.pqrs
      .findOne(filtroPqr(id, copropiedadId, soloDe))
      .exec();
    const adjunto = pqr?.archivosAdjuntos.find(
      (a) => a._id.toString() === adjuntoId,
    );
    if (
      !adjunto ||
      adjunto.estado !== 'listo' ||
      !esRutaDeAdjuntoPqr(adjunto.rutaAlmacenamiento)
    ) {
      throw noEncontrado();
    }
    const [url] = await this.bucket
      .file(adjunto.rutaAlmacenamiento)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + VIGENCIA_URL_ADJUNTO_MS,
      });
    return { url, nombre: adjunto.nombre };
  }

  /** Download from any PQR of the coproperty (staff who can read PQRs). */
  descargarAdjunto(id: string, adjuntoId: string): Promise<DescargaArchivo> {
    return this.descargar(id, adjuntoId);
  }

  /** Download from a PQR the resident filed; anybody else's is a 404. */
  async descargarAdjuntoResidente(
    id: string,
    adjuntoId: string,
    user: IRequestUser,
  ): Promise<DescargaArchivo> {
    return await this.descargar(id, adjuntoId, this.cuentaDelResidente(user));
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

// src/modules/documentos/documentos-almacen.service.ts
import { randomUUID } from 'node:crypto';
import type { Bucket } from '@google-cloud/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GCS_BUCKET } from '../../common/storage/storage.constants';
import {
  disposicionDescarga,
  ENCABEZADOS_SOLO_CREAR,
} from '../../common/storage/subida-firmada';

/**
 * The ONLY Storage prefix this module touches. The financial documents live
 * under their own prefixes (`DocumentoStorageService`); nothing here may read,
 * sign, list or delete outside this one.
 */
export const PREFIJO_DOCUMENTOS = 'documentos-administracion/';

/** How long a signed URL works: one attempt, not a standing credential. */
export const VIGENCIA_URL_MS = 15 * 60 * 1000;

/**
 * The only types a browser may render inline from the bucket's domain: a PDF
 * and raster images. Everything else (HTML, SVG, XML, scripts, anything the
 * uploader invented) is served as a download, because a library file is
 * uploader-chosen and an inline HTML/SVG on the bucket's origin would run
 * script there. Matched exactly against the type pinned at upload.
 */
export const TIPOS_VISTA_PREVIA: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** `type/subtype` of a Content-Type, lower-cased and without parameters. */
export const tipoEsencial = (contentType: string): string =>
  contentType.split(';')[0].trim().toLowerCase();

/** Object path the backend picks for a new file of a coproperty. */
export const rutaParaArchivo = (
  copropiedadId: string,
  nombre: string,
): string => {
  // No separators, no ".." runs: the name is one flat, boring object suffix.
  const nombreSeguro = nombre
    .replace(/[^\w.-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(-120);
  return `${PREFIJO_DOCUMENTOS}${copropiedadId}/${randomUUID()}-${nombreSeguro}`;
};

/** Whether a path lies inside this module's prefix (and is not the bare prefix). */
export const esRutaDeDocumentos = (ruta: string): boolean =>
  ruta.startsWith(PREFIJO_DOCUMENTOS) &&
  ruta.length > PREFIJO_DOCUMENTOS.length;

/**
 * Thin wrapper over the shared bucket that pins every operation to
 * `documentos-administracion/`. It is the single place in this module that
 * touches Storage, so the prefix rule cannot be forgotten at a call site:
 * a path outside it is refused (an `Error` for signing/reading, a logged
 * `false` for deletion, which must never throw).
 *
 * `eliminar` is the single code path in this module that physically deletes a
 * Storage object. Its callers are deleting a file (manage), rejecting an upload
 * over the size limit, and the nightly orphan cron. Nothing here lists the bucket.
 */
@Injectable()
export class DocumentosAlmacenService {
  private readonly logger = new Logger(DocumentosAlmacenService.name);

  constructor(@Inject(GCS_BUCKET) private readonly bucket: Bucket) {}

  private exigir(ruta: string): void {
    if (!esRutaDeDocumentos(ruta)) {
      throw new Error(
        `Ruta fuera de ${PREFIJO_DOCUMENTOS}: se rechaza la operación de almacenamiento.`,
      );
    }
  }

  /**
   * Signed URL to PUT the file, pinned to the declared content type and
   * create-only: once the object exists (and `confirmar` checked it), the same
   * URL cannot replace it. The browser must send the matching
   * `encabezadosSubida`.
   */
  async firmarSubida(ruta: string, mimeType: string): Promise<string> {
    this.exigir(ruta);
    const [url] = await this.bucket.file(ruta).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + VIGENCIA_URL_MS,
      contentType: mimeType,
      extensionHeaders: { ...ENCABEZADOS_SOLO_CREAR },
    });
    return url;
  }

  /**
   * Short-lived signed URL to read the file. A PDF or raster image opens in the
   * browser (`inline`, with its type pinned); anything else is always an
   * `attachment`, so an uploader-chosen HTML/SVG is saved, never rendered from
   * the bucket's domain. `mimeType` is the type the file was uploaded with
   * (pinned in the upload signature and re-checked at `confirmar`).
   */
  async firmarLectura(
    ruta: string,
    nombre: string,
    mimeType: string,
  ): Promise<string> {
    this.exigir(ruta);
    const tipo = tipoEsencial(mimeType);
    const vistaPrevia = TIPOS_VISTA_PREVIA.includes(tipo);
    const [url] = await this.bucket.file(ruta).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + VIGENCIA_URL_MS,
      responseDisposition: vistaPrevia
        ? disposicionDescarga(nombre).replace(/^attachment/, 'inline')
        : disposicionDescarga(nombre),
      ...(vistaPrevia ? { responseType: tipo } : {}),
    });
    return url;
  }

  /**
   * Real size and content type of the uploaded object; rejects when the object
   * is not there. `mimeType` is '' when Storage recorded none.
   */
  async objetoReal(
    ruta: string,
  ): Promise<{ tamanoBytes: number; mimeType: string }> {
    this.exigir(ruta);
    const [metadata] = await this.bucket.file(ruta).getMetadata();
    return {
      tamanoBytes: Number(metadata.size ?? 0),
      mimeType: metadata.contentType ?? '',
    };
  }

  /**
   * Deletes one object. Best-effort: returns false (and logs) when the path is
   * outside the prefix or the delete fails; never throws.
   */
  async eliminar(ruta: string): Promise<boolean> {
    if (!esRutaDeDocumentos(ruta)) {
      this.logger.error(
        `Se rechazó borrar un objeto fuera de ${PREFIJO_DOCUMENTOS}: ${ruta}`,
      );
      return false;
    }
    try {
      await this.bucket.file(ruta).delete();
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo borrar el objeto ${ruta}: ${(error as Error).message}`,
      );
      return false;
    }
  }
}

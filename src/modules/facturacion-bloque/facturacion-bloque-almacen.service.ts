// src/modules/facturacion-bloque/facturacion-bloque-almacen.service.ts
import type { Bucket } from '@google-cloud/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { GCS_BUCKET } from '../../common/storage/storage.constants';
import { ENCABEZADOS_SOLO_CREAR } from '../../common/storage/subida-firmada';

/**
 * The ONLY Storage prefix this module touches. Nothing here may read, sign, list
 * or delete outside it: the financial documents and the document library live
 * under their own prefixes and belong to other services.
 */
export const PREFIJO_BLOQUES = 'facturacion-bloque/';

/** How long a signed URL works: one attempt, not a standing credential. */
export const VIGENCIA_URL_MS = 10 * 60 * 1000;

/** How many object deletes run at once when a prefix is removed. */
const CONCURRENCIA_BORRADO = 10;

const ID_HEX = '[0-9a-f]{24}';

/**
 * The prefixes `eliminarPrefijo` accepts: a coproperty's block folder or the
 * `unidades/` folder inside it, with real 24-hex ids. An empty string, the bare
 * prefix, a coproperty folder or a short id prefix are refused, so a caller bug
 * can never delete more than ONE block.
 */
const PREFIJO_BORRABLE = new RegExp(
  `^${PREFIJO_BLOQUES}${ID_HEX}/${ID_HEX}/(unidades/)?$`,
);

/** Folder of one block: the original and every per-unit file live under it. */
export const prefijoDeBloque = (
  copropiedadId: string,
  bloqueId: string,
): string => `${PREFIJO_BLOQUES}${copropiedadId}/${bloqueId}/`;

/** Object path of the uploaded original. Backend-chosen: the client never picks it. */
export const rutaOriginal = (copropiedadId: string, bloqueId: string): string =>
  `${prefijoDeBloque(copropiedadId, bloqueId)}original.pdf`;

/** Folder of the per-unit files of a block. */
export const prefijoDeUnidades = (
  copropiedadId: string,
  bloqueId: string,
): string => `${prefijoDeBloque(copropiedadId, bloqueId)}unidades/`;

/**
 * Object path of one unit's file. Named by the unit's id (24 hex), never by its
 * code: the code comes out of a PDF and has no business inside an object name,
 * and the id makes the path deterministic, so a re-run of the ingest overwrites
 * instead of leaving orphans.
 */
export const rutaDeUnidad = (
  copropiedadId: string,
  bloqueId: string,
  inmuebleId: string,
): string => `${prefijoDeUnidades(copropiedadId, bloqueId)}${inmuebleId}.pdf`;

/** Whether a path lies inside this module's prefix (and is not the bare prefix). */
export const esRutaDeBloques = (ruta: string): boolean =>
  ruta.startsWith(PREFIJO_BLOQUES) && ruta.length > PREFIJO_BLOQUES.length;

/**
 * Thin wrapper over the shared bucket pinned to `facturacion-bloque/`. It is the
 * single place of this module that touches Storage, so the prefix rule cannot be
 * forgotten at a call site: a path outside it is refused (an `Error` for
 * signing/reading/writing, a logged `false` for deletion, which never throws).
 */
@Injectable()
export class FacturacionBloqueAlmacenService {
  private readonly logger = new Logger(FacturacionBloqueAlmacenService.name);

  constructor(@Inject(GCS_BUCKET) private readonly bucket: Bucket) {}

  private exigir(ruta: string): void {
    if (!esRutaDeBloques(ruta)) {
      throw new Error(
        `Ruta fuera de ${PREFIJO_BLOQUES}: se rechaza la operación de almacenamiento.`,
      );
    }
  }

  /**
   * Signed URL to PUT the original, pinned to `application/pdf` and create-only:
   * once the object exists the same URL cannot replace it, so the PDF the
   * ingest read is the one that stays. The browser must send the matching
   * `encabezadosSubida`.
   */
  async firmarSubida(ruta: string): Promise<string> {
    this.exigir(ruta);
    const [url] = await this.bucket.file(ruta).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + VIGENCIA_URL_MS,
      contentType: 'application/pdf',
      extensionHeaders: { ...ENCABEZADOS_SOLO_CREAR },
    });
    return url;
  }

  /**
   * Short-lived signed URL to read a file. `nombreArchivo` becomes the download
   * name; it is baked into the signature, so the client cannot change it.
   */
  async firmarLectura(ruta: string, nombreArchivo: string): Promise<string> {
    this.exigir(ruta);
    const [url] = await this.bucket.file(ruta).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + VIGENCIA_URL_MS,
      responseType: 'application/pdf',
      responseDisposition: `attachment; filename="${nombreArchivo.replace(/[^\w.-]+/g, '_')}"`,
    });
    return url;
  }

  /** Real size of the uploaded object; rejects when the object is not there. */
  async tamanoReal(ruta: string): Promise<number> {
    this.exigir(ruta);
    const [metadata] = await this.bucket.file(ruta).getMetadata();
    return Number(metadata.size ?? 0);
  }

  /** The object's bytes. The ingest holds ONE such buffer at a time. */
  async descargar(ruta: string): Promise<Buffer> {
    this.exigir(ruta);
    const [bytes] = await this.bucket.file(ruta).download();
    return bytes;
  }

  /** Writes one per-unit PDF (single request, not resumable: they are small). */
  async subir(ruta: string, bytes: Uint8Array): Promise<void> {
    this.exigir(ruta);
    // A view over the same memory, not a copy.
    const contenido = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    await this.bucket
      .file(ruta)
      .save(contenido, { contentType: 'application/pdf', resumable: false });
  }

  /**
   * Deletes one object. Best-effort: returns false (and logs) when the path is
   * outside the prefix or the delete fails; never throws.
   */
  async eliminar(ruta: string): Promise<boolean> {
    if (!esRutaDeBloques(ruta)) {
      this.logger.error(
        `Se rechazó borrar un objeto fuera de ${PREFIJO_BLOQUES}: ${ruta}`,
      );
      return false;
    }
    try {
      await this.bucket.file(ruta).delete({ ignoreNotFound: true });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo borrar el objeto ${ruta}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Deletes every object under `prefijo` (see `PREFIJO_BORRABLE` for the shapes
   * accepted) and reports what actually happened, in bounded batches. A listing
   * failure throws (nothing was touched); a single object failing is counted.
   */
  async eliminarPrefijo(
    prefijo: string,
  ): Promise<{ eliminados: number; fallidos: number }> {
    if (!PREFIJO_BORRABLE.test(prefijo)) {
      throw new Error(
        `El prefijo a eliminar debe ser ${PREFIJO_BLOQUES}<copropiedad>/<bloque>/ para no borrar más de lo previsto.`,
      );
    }
    const [archivos] = await this.bucket.getFiles({ prefix: prefijo });
    let eliminados = 0;
    let fallidos = 0;
    for (let i = 0; i < archivos.length; i += CONCURRENCIA_BORRADO) {
      const resultados = await Promise.allSettled(
        archivos
          .slice(i, i + CONCURRENCIA_BORRADO)
          .map((archivo) => archivo.delete({ ignoreNotFound: true })),
      );
      for (const resultado of resultados) {
        if (resultado.status === 'fulfilled') eliminados++;
        else fallidos++;
      }
    }
    return { eliminados, fallidos };
  }
}

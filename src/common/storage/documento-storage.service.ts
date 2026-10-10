// src/common/storage/documento-storage.service.ts
import { Inject, Injectable } from '@nestjs/common';
import type { Bucket } from '@google-cloud/storage';
import { GCS_BUCKET } from './storage.constants';
import { esPrefijoDocumentosGenerados } from '../documentos/prefijo-documentos-generados';

/** How many object deletes `eliminarPrefijo` keeps in flight at once. */
const CONCURRENCIA_BORRADO = 10;

/**
 * Thin wrapper around one GCS bucket for what this backend does with a
 * generated document: hand out a short-lived signed URL to upload it, hand
 * out another to read it back, and — the one case that needs actual
 * bytes — download an already-confirmed file to extract from it
 * server-side (`descargarBytes`, used by `FacturasController
 * .obtenerDocumentoPdf` to pull one invoice's page out of its lote's
 * combined PDF). Every other path still never reads or writes bytes:
 * pdfmake in the browser produces the PDF, the browser's own PUT against
 * the signed URL moves the bytes, and this service's job stops at
 * issuing/checking the URL.
 *
 * Kept generic over `objectPath` on purpose: it has no notion of
 * `tipoDocumento`/`documentoId`, that structure lives one layer up in
 * `PresentacionDocumentoService.solicitarGeneracion`, which computes the
 * path. This service would be identical for any other future caller that
 * needed a signed URL against this same bucket.
 */
@Injectable()
export class DocumentoStorageService {
  constructor(@Inject(GCS_BUCKET) private readonly bucket: Bucket) {}

  /**
   * Signed URL the browser uploads a freshly generated PDF to, valid for a
   * short window (default 5 minutes) — long enough for one upload attempt,
   * short enough that a leaked URL is worthless soon after. `contentType` is
   * pinned to `application/pdf` in the signature itself, so a client cannot
   * reuse this same URL to upload anything else.
   */
  async generarUrlSubida(
    objectPath: string,
    ttlMs = 5 * 60_000,
  ): Promise<{ uploadUrl: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + ttlMs);
    const [uploadUrl] = await this.bucket.file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresAt,
      contentType: 'application/pdf',
    });
    return { uploadUrl, expiresAt };
  }

  /**
   * Whether `objectPath` actually landed in the bucket. Called from
   * `PresentacionDocumentoService.confirmarGeneracion` precisely because a
   * signed upload URL succeeding client-side is not proof the object
   * exists server-side — the frontend's own claim "ya subí" is never
   * trusted on its own for something that becomes permanent.
   */
  async existe(objectPath: string): Promise<boolean> {
    const [exists] = await this.bucket.file(objectPath).exists();
    return exists;
  }

  /**
   * Signed URL to read back an already-generated document, valid for a
   * longer window (default 10 minutes) than an upload URL — a person opening
   * a document to review it needs more time than a one-shot upload does.
   */
  async generarUrlLectura(
    objectPath: string,
    ttlMs = 10 * 60_000,
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + ttlMs);
    const [url] = await this.bucket.file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresAt,
    });
    return { url, expiresAt };
  }

  /**
   * The actual bytes of an already-confirmed document — deliberately the
   * only method on this service that touches content instead of just a URL.
   * Two callers, both needing the whole file server-side rather than a
   * browser-facing signed URL: `FacturasController.obtenerDocumentoPdf`
   * extracts a single invoice's page out of its lote's combined PDF (handing
   * the signed URL to the client instead would leak every other unit's
   * invoice in the same lote); `GeneracionDocumentoService.documentoPdf`
   * needs the bytes in-process to stamp an "anulada"/"anulado" watermark
   * before serving them, which a direct-to-bucket signed URL can't do.
   */
  async descargarBytes(objectPath: string): Promise<Buffer> {
    const [bytes] = await this.bucket.file(objectPath).download();
    return bytes;
  }

  /**
   * Deletes every object under `prefijo` and reports what ACTUALLY happened:
   * `eliminados` counts the deletes that succeeded, `fallidos` the ones that
   * did not, so a partial failure never reads as "nothing was deleted". Only
   * a failure to LIST throws (nothing was touched then). The one destructive
   * method on this service: it exists for `ReiniciarCicloService`, which
   * wipes a coproperty's generated PDFs.
   *
   * `prefijo` must have the exact shape `prefijoDocumentosGenerados` produces
   * (`documentos-generados/<24-hex id>/`), checked with the validator that
   * lives next to it: an empty string, `/`, the bare folder or a short id
   * prefix is rejected, so a caller bug can never delete more than ONE
   * coproperty's PDFs.
   *
   * Deletes run in bounded batches of `CONCURRENCIA_BORRADO` instead of the
   * bucket's native `deleteFiles({ prefix })`: the native call gives no count
   * of what it deleted (and aborts on the first error), and an unbounded
   * `Promise.all` over thousands of objects would open that many sockets.
   * `ignoreNotFound` makes an object removed between the listing and the
   * delete count as done.
   */
  async eliminarPrefijo(
    prefijo: string,
  ): Promise<{ eliminados: number; fallidos: number }> {
    if (!esPrefijoDocumentosGenerados(prefijo)) {
      throw new Error(
        'El prefijo a eliminar debe ser documentos-generados/<id de copropiedad>/ para no borrar más de lo previsto.',
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

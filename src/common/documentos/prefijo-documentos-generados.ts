import type { Types } from 'mongoose';

/**
 * Storage prefix under which EVERY generated PDF of one coproperty lives
 * (individual documents and lote-level combined files alike: both go through
 * `PresentacionDocumentoService.solicitarGeneracion`, anchored on the
 * document's or lote's own `_id`). Shared by the code that builds a path and
 * the code that wipes a coproperty's files (`ReiniciarCicloService`) so they
 * cannot drift apart. Always ends with `/` so a prefix match on one id can
 * never swallow another.
 *
 * Lives in its own dependency-free file (not in the service that uses it) so
 * `DocumentoStorageService` can import the validator below without creating a
 * cycle with `PresentacionDocumentoService`, which imports the storage service.
 */
export const prefijoDocumentosGenerados = (
  copropiedadId: Types.ObjectId | string,
): string => `documentos-generados/${copropiedadId.toString()}/`;

/**
 * Exact shape of a prefix `prefijoDocumentosGenerados` can produce: the fixed
 * folder, one 24-hex ObjectId, a trailing slash. The destructive storage
 * method refuses anything else, so a caller bug (empty string, `/`, the bare
 * folder, an id prefix) can never delete more than one coproperty's PDFs.
 */
export const esPrefijoDocumentosGenerados = (prefijo: string): boolean =>
  /^documentos-generados\/[0-9a-f]{24}\/$/.test(prefijo);

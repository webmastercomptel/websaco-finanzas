/**
 * Extension header that makes a signed v4 write URL create-only: Storage
 * accepts the PUT only while the object does not exist (generation 0), so the
 * URL cannot replace a file after the backend checked it at `confirmar`
 * (which would bypass the size/type checks). Signed headers must be sent by
 * the browser exactly as signed, so callers hand them back to the client
 * (`encabezadosSubida`), and the bucket CORS must allow this header.
 */
export const ENCABEZADOS_SOLO_CREAR = {
  'x-goog-if-generation-match': '0',
} as const;

/** Headers the browser must send on the PUT of a create-only signed upload. */
export const encabezadosSubida = (
  contentType: string,
): Record<string, string> => ({
  'Content-Type': contentType,
  ...ENCABEZADOS_SOLO_CREAR,
});

/**
 * `Content-Disposition` for a signed download: always `attachment`, so a file
 * whose stored type a user chose is saved, never rendered by the browser.
 */
export const disposicionDescarga = (nombre: string): string =>
  `attachment; filename="${nombre.replace(/[^\w.-]+/g, '_')}"`;

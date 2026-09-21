import { readFileSync } from 'fs';
import { join } from 'path';

/** Same asset every PDF renderer (pdf-lib and react-pdf) reads — one logo
 *  file, read once per process. Moved here from `encabezado-documento.ts`
 *  when the masthead stopped showing it (see `PieDocumento`'s docblock for
 *  why) — this is now the only react-pdf consumer of the WebSACO mark. */
let logoBytesCache: Buffer | null = null;

export function logoBytesWebsaco(): Buffer {
  logoBytesCache ??= readFileSync(
    join(__dirname, '../../assets/websaco-logo.png'),
  );
  return logoBytesCache;
}

/**
 * Same PNG, as a `data:` URI string — what `EncabezadoDocumento`'s banner
 * logo uses instead of the raw `Buffer` above. That `Image` node is the ONE
 * spot a `mostrarLogo` document's tree survives into a frozen
 * `documentDefinition` (see `serializarArbol`'s own docblock on why
 * `CreditoWebsaco`'s identical logo is dropped rather than persisted): a
 * `Buffer` prop round-trips through Mongo/JSON as binary data no browser
 * `<Image src>` can read back, silently rendering blank even though
 * `mostrarLogo` itself came through fine — a plain string doesn't have that
 * problem, and `@react-pdf/image` resolves a `data:` URI on both Node and
 * browser through the same code path, so this is correct rendered directly
 * too, not just after a hydrate round-trip.
 */
let logoDataUriCache: string | null = null;

export function logoDataUriWebsaco(): string {
  logoDataUriCache ??= `data:image/png;base64,${logoBytesWebsaco().toString('base64')}`;
  return logoDataUriCache;
}

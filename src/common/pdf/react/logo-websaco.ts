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

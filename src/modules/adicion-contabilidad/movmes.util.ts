/**
 * Builds the two fixed-column CSV files the target accounting system
 * imports: MOVMES.csv (one row per document/AsientoContable — the "header")
 * and MOVMESDO.csv (one row per debit/credit line — the "detail"). Column
 * order and count are dictated by that external importer, not derived from
 * anything in this codebase — see each function's own docblock for the
 * exact layout.
 *
 * A comma or newline inside a free-text field (`detalle`) is replaced with a
 * space rather than RFC4180-quoted: this is a FIXED-column import, and a
 * legacy tool built around that assumption is far more likely to choke on a
 * stray quoted comma than to lose one character from a description.
 */

/** Business dates in this app are stored as UTC midnight — using local
 *  getters here would read as the day before west of Greenwich. */
const dosDigitos = (n: number): string => String(n).padStart(2, '0');

/** Exported for `AdicionContabilidadService.resolveConceptos` — the FV
 *  "Cargo del Periodo" detalle formats `Factura.periodStart`/`periodEnd`
 *  with this exact dd/mm/aaaa convention, same UTC-midnight reasoning. */
export const fechaDdMmAaaa = (fecha: Date): string =>
  `${dosDigitos(fecha.getUTCDate())}/${dosDigitos(fecha.getUTCMonth() + 1)}/${fecha.getUTCFullYear()}`;

const mesDosDigitos = (fecha: Date): string =>
  dosDigitos(fecha.getUTCMonth() + 1);

/** Comma/newline would shift every column after it in a fixed-column
 *  import — replaced with a space rather than quoted. */
const limpiarTexto = (valor: string): string =>
  valor.replace(/[\r\n,]+/g, ' ').trim();

/** Wraps a value already padded to a fixed width so `campo` skips `.trim()`
 *  — plain `limpiarTexto` would eat the very padding spaces these fields
 *  exist to carry (e.g. a short/absent `tercero` pads with trailing spaces
 *  that would otherwise be stripped, silently shrinking the field). */
class CampoFijo {
  constructor(public readonly valor: string) {}
}
const campoFijo = (valor: string): CampoFijo => new CampoFijo(valor);

/** Same comma/newline guard as `limpiarTexto`, without the trim. */
const limpiarSinTrim = (valor: string): string =>
  valor.replace(/[\r\n,]+/g, ' ');

const campo = (valor: string | number | null | CampoFijo): string => {
  if (valor === null) return '';
  if (valor instanceof CampoFijo) return limpiarSinTrim(valor.valor);
  return typeof valor === 'number' ? String(valor) : limpiarTexto(valor);
};

const filaCsv = (campos: (string | number | null | CampoFijo)[]): string =>
  campos.map(campo).join(',');

const TIPO_DOCUMENTO_ANCHO = 4;
const NUMERO_DOCUMENTO_ANCHO = 15;
const CUENTA_ANCHO = 10;
const TERCERO_ANCHO = 15;

const encajarIzquierda = (valor: string, ancho: number): string =>
  valor.slice(0, ancho).padEnd(ancho);

/** MOVMES column 3 / MOVMESDO column 2 — the fixed-width key the target
 *  importer cross-references a detail line back to its header with: tipo
 *  documento left-padded to 4 chars + número right-justified to 15, e.g.
 *  "FV             4152" (19 chars total, no separator between the two). */
export const documentoCruce = (tipoDocumento: string, numero: number): string =>
  encajarIzquierda(tipoDocumento, TIPO_DOCUMENTO_ANCHO) +
  String(numero).padStart(NUMERO_DOCUMENTO_ANCHO);

export interface FilaMovmes {
  tipoDocumento: string;
  numero: number;
  fecha: Date;
  numeroLote: number;
  detalle: string;
}

/**
 * MOVMES.csv — one row per documento (AsientoContable), 17 columns:
 * 1 tipo documento, 2 número, 3 tipo+número documento (fixed-width, see
 * `documentoCruce` — MOVMESDO column 2 repeats this exact value to cross-
 * reference back to this row), 4 blank, 5 fecha (dd/mm/aaaa), 6 número
 * lote, 7 mes (2 dígitos), 8 año, 9 detalle, 10-16 blank (7 columns), 17 "3"
 * (a fixed literal the target importer requires).
 */
export function construirMovmes(filas: FilaMovmes[]): string {
  const lineas = filas.map((f) =>
    filaCsv([
      f.tipoDocumento,
      f.numero,
      campoFijo(documentoCruce(f.tipoDocumento, f.numero)),
      '',
      fechaDdMmAaaa(f.fecha),
      f.numeroLote,
      mesDosDigitos(f.fecha),
      f.fecha.getUTCFullYear(),
      f.detalle,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '3',
    ]),
  );
  return lineas.join('\r\n') + '\r\n';
}

export interface FilaMovmesdo {
  tipoDocumento: string;
  numero: number;
  cuenta: string;
  centroCosto: string | null;
  tercero: string | null;
  detalle: string;
  baseGravable: number | null;
  valorDebito: number | null;
  valorCredito: number | null;
  comprobante: string | null;
  numeroDocCruce: number | null;
}

/**
 * MOVMESDO.csv — one row per transacción (Movimiento/entries line), 18
 * columns: 1 código de cuenta + tercero (fixed-width: cuenta padded to 10
 * chars + tercero padded to 15, 25 chars total — the target importer's own
 * concatenated account/tercero key), 2 tipo+número documento (same fixed-
 * width value as MOVMES column 3, via `documentoCruce` — ties this detail
 * line back to its header row), 3 código de cuenta, 4 centro de utilidad,
 * 5 centro de destino (same value as 4 — the underlying data model carries
 * one `centroCosto`, not two distinct centres), 6 tercero, 7 detalle, 8 base
 * de impuesto, 9 valor débito, 10 valor crédito, 11 comprobante, 12-13
 * blank, 14 número doc cruce, 15-17 blank, 18 "3" (a fixed literal the
 * target importer requires).
 */
export function construirMovmesdo(filas: FilaMovmesdo[]): string {
  const lineas = filas.map((f) =>
    filaCsv([
      campoFijo(
        encajarIzquierda(f.cuenta, CUENTA_ANCHO) +
          encajarIzquierda(f.tercero ?? '', TERCERO_ANCHO),
      ),
      campoFijo(documentoCruce(f.tipoDocumento, f.numero)),
      f.cuenta,
      f.centroCosto,
      f.centroCosto,
      f.tercero,
      f.detalle,
      f.baseGravable,
      f.valorDebito,
      f.valorCredito,
      f.comprobante,
      '',
      '',
      f.numeroDocCruce,
      '',
      '',
      '',
      '3',
    ]),
  );
  return lineas.join('\r\n') + '\r\n';
}

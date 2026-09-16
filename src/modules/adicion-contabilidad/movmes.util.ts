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

const campo = (valor: string | number | null): string => {
  if (valor === null) return '';
  return typeof valor === 'number' ? String(valor) : limpiarTexto(valor);
};

const filaCsv = (campos: (string | number | null)[]): string =>
  campos.map(campo).join(',');

export interface FilaMovmes {
  tipoDocumento: string;
  numero: number;
  fecha: Date;
  numeroLote: number;
  detalle: string;
}

/**
 * MOVMES.csv — one row per documento (AsientoContable), 17 columns:
 * 1 tipo documento, 2 número, 3-4 blank, 5 fecha (dd/mm/aaaa), 6 número
 * lote, 7 mes (2 dígitos), 8 año, 9 detalle, 10-16 blank (7 columns), 17 "3"
 * (a fixed literal the target importer requires).
 */
export function construirMovmes(filas: FilaMovmes[]): string {
  const lineas = filas.map((f) =>
    filaCsv([
      f.tipoDocumento,
      f.numero,
      '',
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
 * columns: 1-2 blank, 3 código de cuenta, 4 centro de utilidad, 5 centro de
 * destino (same value as 4 — the underlying data model carries one
 * `centroCosto`, not two distinct centres), 6 tercero, 7 detalle, 8 base de
 * impuesto, 9 valor débito, 10 valor crédito, 11 comprobante, 12-13 blank,
 * 14 número doc cruce, 15-17 blank, 18 "3" (a fixed literal the target
 * importer requires).
 */
export function construirMovmesdo(filas: FilaMovmesdo[]): string {
  const lineas = filas.map((f) =>
    filaCsv([
      '',
      '',
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

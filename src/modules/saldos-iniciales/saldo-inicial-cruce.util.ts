import type { ClientSession, Model, Types } from 'mongoose';
import type { SaldoInicialDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';

/**
 * A Saldo Inicial as it must be shown as a "documento cruce": the document it
 * was in the client's previous system (`FV` / `2941`), never the internal
 * `SI` tag nor the internal ordinal (`SaldoInicial.numero`).
 */
export interface DocumentoCruceSaldoInicial {
  tipo: string;
  numero: string;
}

/** The minimal asiento shape this resolver reads — keeps it independent of
 *  the Mongoose document type. */
interface AsientoConMovimientos {
  movimientos: {
    tipoDocumento?: 'FV' | 'ND' | 'SI' | null;
    numeroDocumento?: number | null;
  }[];
}

/**
 * Asientos posted for a payment applied against a Saldo Inicial store
 * `tipoDocumento: 'SI'` + the INTERNAL ordinal (`SaldoInicial.numero`) on the
 * movimiento — there is no id on the movimiento, and rewriting stored data is
 * deliberately avoided (already-posted production asientos must resolve too),
 * so the user-facing document is resolved at READ time: one tenant-scoped
 * query by `(copropiedadId, numero)` for every distinct ordinal present.
 *
 * Returns a map keyed by the internal ordinal. An ordinal with no matching
 * Saldo Inicial is simply absent (the caller falls back to the stored value).
 */
export async function resolverSaldosInicialesPorNumero(
  saldosIniciales: Model<SaldoInicialDocument> | undefined,
  copropiedadId: Types.ObjectId,
  asientos: AsientoConMovimientos[],
  session?: ClientSession,
): Promise<Map<number, DocumentoCruceSaldoInicial>> {
  const mapa = new Map<number, DocumentoCruceSaldoInicial>();
  if (!saldosIniciales) return mapa;

  const numeros = new Set<number>();
  for (const asiento of asientos) {
    for (const mov of asiento.movimientos) {
      if (mov.tipoDocumento === 'SI' && mov.numeroDocumento != null) {
        numeros.add(mov.numeroDocumento);
      }
    }
  }
  if (numeros.size === 0) return mapa;

  const consulta = saldosIniciales.find(
    { copropiedadId, numero: { $in: [...numeros] } },
    { numero: 1, tipoDocumentoOriginal: 1, numeroOriginal: 1 },
  );
  const docs = await (session ? consulta.session(session) : consulta).exec();
  for (const si of docs) {
    mapa.set(si.numero, {
      tipo: si.tipoDocumentoOriginal,
      numero: si.numeroOriginal,
    });
  }
  return mapa;
}

/**
 * The documento cruce to DISPLAY/EXPORT for one stored movimiento line: for a
 * Saldo Inicial (`'SI'`) the original document, otherwise what was stored.
 * `null` when the line carries no documento cruce at all.
 */
export function documentoCruceDeMovimiento(
  mov: {
    tipoDocumento?: 'FV' | 'ND' | 'SI' | null;
    numeroDocumento?: number | null;
  },
  saldosInicialesPorNumero: Map<number, DocumentoCruceSaldoInicial>,
): { tipo: string; numero: string | number } | null {
  if (!mov.tipoDocumento || mov.numeroDocumento == null) return null;
  if (mov.tipoDocumento === 'SI') {
    const original = saldosInicialesPorNumero.get(mov.numeroDocumento);
    if (original) return original;
  }
  return { tipo: mov.tipoDocumento, numero: mov.numeroDocumento };
}

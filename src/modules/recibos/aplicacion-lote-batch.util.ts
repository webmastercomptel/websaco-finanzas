import { Types } from 'mongoose';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { SaldoInicialDocument } from '../../database/schemas/saldos-iniciales/saldo-inicial.schema';
import { claveMesDe } from '../../common/contabilidad/periodo.service';
import { formatoFecha } from '../../common/contabilidad/periodo-calendario.util';
import type { MarcasCuentaContable } from '../facturacion/asiento.builder';

/** The inmueble fields this whole module ever reads — deliberately narrow
 *  (never the full `InmuebleDocument`) so the pure functions below stay
 *  decoupled from the schema, same style `cruce.util.ts`'s own
 *  `OrigenAplicacion` uses. */
export interface InmuebleParaAplicacionLote {
  _id: Types.ObjectId;
  holderId: Types.ObjectId | null;
  code: string;
}

/** The coproperty fields this whole module ever reads — a superset of
 *  `asiento.builder.ts`'s own `CopropiedadParaCuentasOrden`, so any value
 *  of this shape is also valid input to `cuentasOrdenDe`. */
export interface CopropiedadParaAplicacionLote {
  receivablesAccount: string | null;
  advancesAccount: string | null;
  discountsDebitAccount: string | null;
  usesMemorandumAccounts: boolean;
  memorandumDebitAccount: string | null;
  memorandumCreditAccount: string | null;
  defaultCostCentre: string | null;
  cashFlowCode: string | null;
  defaultBankAccountCode: string | null;
}

/** One FIFO candidate, already resolved to its real document — kept as a
 *  small discriminated union (not three parallel arrays) so `aplicarFifoEnMemoria`
 *  (Task 4) can walk ONE list in priority order, exactly like `abiertas` in
 *  today's `ejecutarAplicacionFifo`. Priority order is computed ONCE, at
 *  batch-read time (Task 3) — it never changes as balances shrink, only
 *  `saldoPorDocumento` does, so it is safe to reuse across every row of a
 *  tanda that shares this inmueble. */
export type CandidatoAplicacionLote =
  | { tipo: 'FV'; doc: FacturaDocument }
  | { tipo: 'ND'; doc: NotaDebitoDocument }
  | { tipo: 'SI'; doc: SaldoInicialDocument };

/** Everything the batch-lote path knows about ONE inmueble, before any row
 *  against it has been processed. `saldoPorDocumento` is the ONLY mutable
 *  part — `aplicarFifoEnMemoria` (Task 4) decrements it in place as each
 *  row in a tanda consumes balance, so a second row against the same
 *  inmueble in the same tanda sees the first row's own consumption. */
export interface DatosInmuebleParaAplicacionLote {
  inmueble: InmuebleParaAplicacionLote;
  candidatosOrdenados: CandidatoAplicacionLote[];
  /** Keyed by `doc._id.toString()`. */
  saldoPorDocumento: Map<string, number>;
}

/** Everything read ONCE for the whole `aplicar()` call, before any tanda
 *  opens — design §4. */
export interface DatosBatchAplicacionLote {
  /** Keyed by `inmuebleId.toString()`. */
  indicePorInmueble: Map<string, DatosInmuebleParaAplicacionLote>;
  copropiedad: CopropiedadParaAplicacionLote | null;
  cuentasContablesPorCodigo: Map<string, MarcasCuentaContable>;
  /** Keyed by `claveMesDe(fila.fechaPago)` — one entry per DISTINCT month
   *  among the lote's pending rows, not per row. */
  periodoAbiertoPorMes: Map<string, boolean>;
  ultimoLoteFacturacion: { periodStart: Date; periodEnd: Date } | null;
}

export { claveMesDe };

/**
 * Everything `RecibosService.prepararCreacion()` validates per row today,
 * replayed against the pre-fetched batch data instead of live queries —
 * inmueble has a titular, the row's own month is open, the row's date
 * falls inside the current billing period. Mutual-exclusivity/shortfall/
 * surplus checks from `prepararCreacion` are NOT reproduced here: they only
 * ever fire for `dto.aplicaciones`/`dto.destinoSobrante`, and the batch path
 * never sets either (every row is `aplicacionAutomatica: true`, nothing
 * else) — see Task 5's own docblock for the full list of branches this
 * lets the batch path skip.
 *
 * Returns a validation OUTCOME, never throws — `exigirPeriodoFacturacionActual`
 * (the live function this mirrors) throws a `BadRequestException`; inlining
 * the same date comparison as a plain boolean check here (rather than
 * calling that function and catching) keeps this function throw-free like
 * every other pure function in this file, and needs no `try/catch` noise in
 * `procesarFilasTandaAplicacionLote` (Task 6) — a judgment call documented
 * in this plan's own report, since the design didn't specify which way to
 * resolve the throw-vs-boolean mismatch.
 */
export function validarFilaAplicacionLote(
  fila: {
    inmuebleId: Types.ObjectId | null;
    inmuebleCodigo: string;
    fechaPago: Date;
  },
  datos: DatosBatchAplicacionLote,
): { valido: true } | { valido: false; mensaje: string } {
  const datosInmueble = fila.inmuebleId
    ? datos.indicePorInmueble.get(fila.inmuebleId.toString())
    : undefined;
  if (!datosInmueble || !datosInmueble.inmueble.holderId) {
    return {
      valido: false,
      mensaje: `El inmueble ${fila.inmuebleCodigo} ya no tiene titular asignado`,
    };
  }

  const clave = claveMesDe(fila.fechaPago);
  const abierto = datos.periodoAbiertoPorMes.get(clave) ?? true;
  if (!abierto) {
    const [year, month] = clave.split('-');
    return {
      valido: false,
      mensaje:
        `El periodo ${month}/${year} está cerrado. Emitá el documento con ` +
        'fecha de hoy, referenciando el documento original.',
    };
  }

  if (datos.ultimoLoteFacturacion) {
    const { periodStart, periodEnd } = datos.ultimoLoteFacturacion;
    if (fila.fechaPago < periodStart || fila.fechaPago > periodEnd) {
      return {
        valido: false,
        mensaje:
          'La fecha de pago debe estar dentro del período de facturación ' +
          `actual (${formatoFecha(periodStart)} – ${formatoFecha(periodEnd)})`,
      };
    }
  }

  return { valido: true };
}

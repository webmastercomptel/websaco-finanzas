import type {
  Factura as FacturaContract,
  FacturaLinea as FacturaLineaContract,
  TitularFactura,
} from '../../contracts';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { TitularCongelado } from '../../database/schemas/facturacion/factura-linea.schema';
import type { FacturaLinea } from '../../database/schemas/facturacion/factura-linea.schema';

export const titularDe = (
  titular: TitularCongelado | null,
): TitularFactura | null =>
  titular
    ? {
        nombre: titular.name,
        tipoIdentificacion: titular.identificationType,
        numeroIdentificacion: titular.identificationNumber,
        digitoVerificacion: titular.identificationVerificationDigit,
        direccion: titular.address,
        ciudad: titular.city,
        email: titular.email,
      }
    : null;

export const lineaDe = (
  linea: FacturaLinea,
  saldoPendiente: number,
): FacturaLineaContract => ({
  conceptoId: linea.conceptoId.toString(),
  nombreConcepto: linea.conceptName,
  tipoConcepto: linea.conceptKind,
  origen: linea.source,
  novedadId: linea.novedadId ? linea.novedadId.toString() : null,
  valorBase: linea.baseAmount,
  tasaImpuesto: linea.taxRate,
  valorImpuesto: linea.taxAmount,
  valorTotal: linea.totalAmount,
  saldoAnterior: linea.balanceBefore,
  nuevoSaldo: linea.balanceAfter,
  // El saldo VIVO de esta línea — a diferencia de saldoAnterior/nuevoSaldo,
  // que son la foto congelada al emitir, este es cuánto le queda pendiente
  // hoy (lo que valida y muestra el reparto manual de un Recibo).
  saldoPendiente,
});

/**
 * Maps an invoice document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md.
 *
 * `saldoPendiente` (top-level) and each línea's own `saldoPendiente` are no
 * longer fields on the (now immutable) document — `Factura.outstandingBalance`/
 * `FacturaLinea.remainingAmount` are gone precisely so a Factura never changes
 * after issuance (see `SaldoTotalDocumento`/`CarteraPorDocumento`'s own
 * docblocks). Both are resolved by the caller — `FacturasService`, which
 * batch-reads them from those two live ledgers — and passed in here, same
 * pattern `toNotaDebito` already uses for its own `saldoPendiente`.
 */
export const toFactura = (
  doc: FacturaDocument,
  saldoPendiente: number,
  saldoPorConcepto: Map<string, number>,
): FacturaContract => ({
  id: doc._id.toString(),
  loteId: doc.loteId.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  inmuebleCodigo: doc.unitCode,
  terceroId: doc.terceroId ? doc.terceroId.toString() : null,
  titular: titularDe(doc.holder),
  prefijo: doc.prefix,
  numero: doc.number,
  numeroCompleto: doc.fullNumber,
  fechaEmision: doc.issueDate.toISOString(),
  fechaVencimiento: doc.dueDate.toISOString(),
  periodoDesde: doc.periodStart.toISOString(),
  periodoHasta: doc.periodEnd.toISOString(),
  lineas: doc.lines.map((linea) =>
    lineaDe(linea, saldoPorConcepto.get(linea.conceptoId.toString()) ?? 0),
  ),
  subtotal: doc.subtotal,
  totalImpuestos: doc.totalTax,
  total: doc.total,
  saldoPendiente,
  montoDescuento: doc.discountAmount,
  fechaLimiteDescuento: doc.discountDeadline
    ? doc.discountDeadline.toISOString()
    : null,
  estado: doc.status,
});

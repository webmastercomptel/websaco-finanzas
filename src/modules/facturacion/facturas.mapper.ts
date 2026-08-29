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

export const lineaDe = (linea: FacturaLinea): FacturaLineaContract => ({
  conceptoId: linea.conceptoId.toString(),
  nombreConcepto: linea.conceptName,
  tipoConcepto: linea.conceptKind,
  origen: linea.source,
  valorBase: linea.baseAmount,
  tasaImpuesto: linea.taxRate,
  valorImpuesto: linea.taxAmount,
  valorTotal: linea.totalAmount,
});

/**
 * Maps an invoice document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in AGENTS.md.
 */
export const toFactura = (doc: FacturaDocument): FacturaContract => ({
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
  lineas: doc.lines.map(lineaDe),
  subtotal: doc.subtotal,
  totalImpuestos: doc.totalTax,
  total: doc.total,
  saldoPendiente: doc.outstandingBalance,
  estado: doc.status,
});

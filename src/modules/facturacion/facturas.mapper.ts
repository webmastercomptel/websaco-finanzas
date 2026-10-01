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
        nombre: titular.nombre,
        tipoIdentificacion: titular.tipoIdentificacion,
        numeroIdentificacion: titular.numeroIdentificacion,
        digitoVerificacion: titular.digitoVerificacion,
        direccion: titular.direccion,
        ciudad: titular.ciudad,
        email: titular.email,
        telefono: titular.telefono,
      }
    : null;

export const lineaDe = (
  linea: FacturaLinea,
  saldoPendiente: number,
): FacturaLineaContract => ({
  conceptoId: linea.conceptoId.toString(),
  nombreConcepto: linea.nombreConcepto,
  tipoConcepto: linea.tipoConcepto,
  origen: linea.origen,
  novedadId: linea.novedadId ? linea.novedadId.toString() : null,
  valorBase: linea.valorBase,
  tasaImpuesto: linea.tasaImpuesto,
  valorImpuesto: linea.valorImpuesto,
  valorTotal: linea.valorTotal,
  saldoAnterior: linea.saldoAnterior,
  nuevoSaldo: linea.saldoNuevo,
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
 * longer fields on the (now immutable) document — `Factura.saldoPendiente`/
 * `FacturaLinea.saldoPendiente` are gone precisely so a Factura never changes
 * after issuance (see `SaldoTotalDocumento`/`CarteraPorDocumento`'s own
 * docblocks). Both are resolved by the caller — `FacturasService`, which
 * batch-reads them from those two live ledgers — and passed in here, same
 * pattern `toNotaDebito` already uses for its own `saldoPendiente`.
 *
 * There is no `objectPath`/`generatedAt` on this contract, unlike every
 * other financial document: a Factura is batch-only, and its lote's invoice
 * run produces ONE combined PDF (anchored on the Lote's own id — see
 * `SolicitudGeneracionFacturaLote`), never a per-invoice file. Viewing one
 * invoice on demand is computed live instead (`GET /facturas/:id/documento`
 * — see `DocumentoFactura`), precisely so it never reads from that combined
 * file (which would leak every other unit's invoice).
 */
export const toFactura = (
  doc: FacturaDocument,
  saldoPendiente: number,
  saldoPorConcepto: Map<string, number>,
): FacturaContract => ({
  id: doc._id.toString(),
  loteId: doc.loteId.toString(),
  inmuebleId: doc.inmuebleId.toString(),
  inmuebleCodigo: doc.codigoInmueble,
  terceroId: doc.terceroId ? doc.terceroId.toString() : null,
  titular: titularDe(doc.titular),
  prefijo: doc.prefijo,
  numero: doc.numero,
  numeroCompleto: doc.numeroCompleto,
  fechaEmision: doc.fechaEmision.toISOString(),
  fechaVencimiento: doc.fechaVencimiento.toISOString(),
  periodoDesde: doc.periodoDesde.toISOString(),
  periodoHasta: doc.periodoHasta.toISOString(),
  lineas: doc.lineas.map((linea) =>
    lineaDe(linea, saldoPorConcepto.get(linea.conceptoId.toString()) ?? 0),
  ),
  subtotal: doc.subtotal,
  totalImpuestos: doc.totalImpuestos,
  total: doc.total,
  saldoPendiente,
  montoDescuento: doc.montoDescuento,
  fechaLimiteDescuento: doc.fechaLimiteDescuento
    ? doc.fechaLimiteDescuento.toISOString()
    : null,
  estado: doc.estado,
  motivoAnulacion: doc.motivoAnulacion,
  detalleAnulacion: doc.detalleAnulacion,
  fechaAnulacion: doc.fechaAnulacion ? doc.fechaAnulacion.toISOString() : null,
});

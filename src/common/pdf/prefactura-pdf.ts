import type { ReactElement } from 'react';
import { contenidoDocumentoFacturacion } from './factura-pdf';
import { calcularDescuentoProntoPago } from '../facturacion/descuento-pronto-pago.util';
import type { DatosDocumentoFacturacion } from './factura-pdf';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * One Preliminar's page content — reused both for a single unit's preview
 * and, mapped across `lote.preview`, for the whole lote's batch (see
 * `LotesController.obtenerDocumentoPrefactura`/`obtenerDocumentosPrefacturas`).
 * Never rendered to bytes here: a Prefactura has no issuance moment to
 * freeze, so each request serializes this tree fresh (`serializarArbol`)
 * for the browser to render, same as `paginaFactura`'s frozen counterpart.
 */
export function paginaPrefactura(
  preliminar: FacturaPreliminar,
  lote: LoteFacturacionDocument,
  copropiedad: CopropiedadDocument,
): ReactElement {
  const { discountAmount, discountDeadline } = calcularDescuentoProntoPago(
    preliminar.lines,
    lote.earlyPaymentDiscount,
    lote.earlyPaymentDiscountFixedValue,
    lote.discountDeadline,
    copropiedad.discountAppliesWithLateFee,
  );
  const descuento =
    discountAmount > 0 && discountDeadline
      ? { fechaLimite: discountDeadline, monto: discountAmount }
      : null;

  const datos: DatosDocumentoFacturacion = {
    titulo: 'PREFACTURA',
    unitCode: preliminar.unitCode,
    holder: preliminar.holder,
    issueDate: lote.billingDate,
    dueDate: lote.dueDate,
    periodStart: lote.periodStart,
    periodEnd: lote.periodEnd,
    lines: preliminar.lines,
    descuento,
    marcaDuplicado: null,
  };

  return contenidoDocumentoFacturacion(datos, copropiedad);
}

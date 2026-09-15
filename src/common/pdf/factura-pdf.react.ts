import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import { reporteDocumento, renderizarPdf } from './react/document';
import { EncabezadoDocumento } from './react/encabezado-documento';
import { DatosAdquiriente, type PeriodoDocumento } from './react/datos-adquiriente';
import { CuerpoFactura, type CargoFactura } from './react/cuerpo-factura';
import { ObservacionesFactura } from './react/observaciones-factura';
import { MarcaDuplicado } from './react/marca-duplicado';
import { CreditoWebsaco } from './react/credito-websaco';
import type { DatosDocumentoFacturacion } from './factura-pdf';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const styles = StyleSheet.create({
  iva: {
    fontSize: 10,
    fontFamily: 'Helvetica-Bold',
    textAlign: 'right',
    marginTop: -6,
    marginBottom: 8,
  },
  pieResolucion: {
    fontSize: 8,
    marginTop: 4,
  },
});

/**
 * Shared body for Factura and Prefactura — react-pdf port of
 * `generarContextoDocumentoFacturacion` (`factura-pdf.ts`), composed from
 * Bernardo's approved layout components (`EncabezadoDocumento`,
 * `DatosAdquiriente`, `CuerpoFactura`, `ObservacionesFactura`) instead of
 * pdf-lib coordinate drawing. Returns page content only — `generarPdfFactura`
 * still appends the DIAN footer on top before rendering; `generarPdfPrefactura`
 * uses this as-is.
 *
 * The IVA breakout row (only when `totalIva > 0`) isn't part of
 * `CuerpoFactura` — that component is Bernardo's in-flight file, so this adds
 * it as a sibling line right below instead of editing his component.
 */
export function contenidoDocumentoFacturacion(
  datos: DatosDocumentoFacturacion,
  copropiedad: CopropiedadDocument,
): ReactElement {
  const totalSaldoAnterior = datos.lines.reduce(
    (acc, l) => acc + l.balanceBefore,
    0,
  );
  const totalCargosDelMes = datos.lines.reduce(
    (acc, l) => acc + l.baseAmount,
    0,
  );
  const totalNuevoSaldo = totalSaldoAnterior + totalCargosDelMes;
  const totalIva = datos.lines.reduce((acc, l) => acc + l.taxAmount, 0);
  const totalAPagar = datos.lines.reduce((acc, l) => acc + l.balanceAfter, 0);

  const cargos: CargoFactura[] = datos.lines.map((l) => ({
    nombre: l.taxAmount > 0 ? `${l.conceptName} (${l.taxRate}%)` : l.conceptName,
    saldoAnterior: l.balanceBefore,
    cargosDelMes: l.baseAmount,
    nuevoSaldo: l.balanceBefore + l.baseAmount,
  }));

  const tasasIva = new Set(
    datos.lines.filter((l) => l.taxAmount > 0).map((l) => l.taxRate),
  );
  const etiquetaIva = tasasIva.size === 1 ? `IVA ${[...tasasIva][0]}%` : 'IVA';

  const h = datos.holder;
  const identificacion = h
    ? [h.identificationType, h.identificationNumber].filter(Boolean).join(' ')
    : null;

  const periodo: PeriodoDocumento = {
    fecha: formatoFecha(datos.issueDate),
    vence: formatoFecha(datos.dueDate),
    desde: formatoFecha(datos.periodStart),
    hasta: formatoFecha(datos.periodEnd),
  };

  const descuentoProps = datos.descuento
    ? {
        fechaLimite: datos.descuento.fechaLimite.toISOString(),
        montoConDescuento: totalAPagar - datos.descuento.monto,
      }
    : undefined;
  const notas = copropiedad.billingNotes?.trim() || null;

  return createElement(
    View,
    null,
    datos.marcaDuplicado
      ? createElement(MarcaDuplicado, { fechaEmisionIso: datos.marcaDuplicado })
      : null,
    createElement(EncabezadoDocumento, {
      copropiedad,
      titulo: datos.titulo,
    }),
    createElement(DatosAdquiriente, {
      inmuebleCodigo: datos.unitCode,
      nombre: h?.name ?? '',
      direccion: h?.address ?? '',
      celular: null,
      email: h?.email ?? null,
      identificacion,
      uso: null,
      periodo,
    }),
    createElement(CuerpoFactura, {
      cargos,
      totalSaldoAnterior,
      totalCargosDelMes,
      totalNuevoSaldo,
      totalAPagar,
    }),
    totalIva > 0
      ? createElement(
          Text,
          { style: styles.iva },
          `${etiquetaIva}: ${formatoPeso(totalIva)}`,
        )
      : null,
    notas || descuentoProps
      ? createElement(ObservacionesFactura, {
          texto: notas,
          descuento: descuentoProps,
        })
      : null,
    createElement(CreditoWebsaco),
  );
}

/**
 * One Factura's full page content (body + DIAN footer) — factored out of
 * `generarPdfFacturaReactPdf` so `facturas-lote-pdf.react.ts` can reuse the
 * exact same per-invoice content across N pages of one `<Document>`, instead
 * of rendering N separate PDFs and merging bytes (pdf-lib's approach, with
 * no react-pdf equivalent).
 */
export function paginaFactura(
  factura: FacturaDocument,
  resolucion: ResolucionFacturacionDocument | null,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): ReactElement {
  const titulo = `${resolucion?.displayName ?? 'Cobro Expensas Comunes'} ${factura.fullNumber}`;
  const descuento =
    factura.discountAmount > 0 && factura.discountDeadline
      ? { fechaLimite: factura.discountDeadline, monto: factura.discountAmount }
      : null;

  const datos: DatosDocumentoFacturacion = {
    titulo,
    unitCode: factura.unitCode,
    holder: factura.holder,
    issueDate: factura.issueDate,
    dueDate: factura.dueDate,
    periodStart: factura.periodStart,
    periodEnd: factura.periodEnd,
    lines: factura.lines,
    descuento,
    marcaDuplicado: opciones?.duplicado
      ? factura.issueDate.toISOString()
      : null,
  };

  const pie = resolucion
    ? createElement(
        Text,
        { style: styles.pieResolucion },
        `Resolución de Facturación DIAN No. ${resolucion.resolutionNumber} ` +
          `del ${formatoFecha(resolucion.validFrom)}. ` +
          `Numeración autorizada de ${resolucion.prefix}${resolucion.rangeFrom} ` +
          `a ${resolucion.prefix}${resolucion.rangeTo}` +
          (resolucion.validUntil
            ? ` vigente hasta ${formatoFecha(resolucion.validUntil)}`
            : ''),
      )
    : null;

  return createElement(View, null, contenidoDocumentoFacturacion(datos, copropiedad), pie);
}

/**
 * React-pdf port of `generarPdfFactura` (`factura-pdf.ts`, kept unchanged and
 * still wired into the controller). Same DIAN resolution footer, same
 * duplicado behavior, different renderer underneath.
 */
export async function generarPdfFacturaReactPdf(
  factura: FacturaDocument,
  resolucion: ResolucionFacturacionDocument | null,
  copropiedad: CopropiedadDocument,
  opciones?: { duplicado?: boolean },
): Promise<Buffer> {
  return renderizarPdf(
    reporteDocumento(paginaFactura(factura, resolucion, copropiedad, opciones)),
  );
}

import { createElement, type ReactElement } from 'react';
import { StyleSheet, Text, View } from '@react-pdf/renderer';
import { formatoFecha, formatoPeso } from './pdf-helpers';
import { EncabezadoDocumento } from './react/encabezado-documento';
import {
  DatosAdquiriente,
  type PeriodoDocumento,
} from './react/datos-adquiriente';
import { CuerpoFactura, type CargoFactura } from './react/cuerpo-factura';
import { ObservacionesFactura } from './react/observaciones-factura';
import { MarcaDuplicado } from './react/marca-duplicado';
import { CreditoWebsaco } from './react/credito-websaco';
import type {
  FacturaLinea,
  TitularCongelado,
} from '../../database/schemas/facturacion/factura-linea.schema';
import type { FacturaLean } from '../../modules/facturacion/facturas.service';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

/**
 * What the shared renderer needs, independent of whether it came from an
 * already-numbered Factura or a still-editable FacturaPreliminar — the two
 * are visually identical documents (per product decision), so this is the
 * only shape either builder has to produce.
 */
export interface DatosDocumentoFacturacion {
  titulo: string;
  unitCode: string;
  holder: TitularCongelado | null;
  issueDate: Date;
  dueDate: Date;
  periodStart: Date;
  periodEnd: Date;
  lines: FacturaLinea[];
  descuento: InfoDescuentoProntoPago | null;
  /** ISO date string when this is a reprint ("DUPLICADO"), null otherwise —
   *  rendered via `MarcaDuplicado`, drawn FIRST in the content tree so every
   *  real number/label painted afterward lands on top of it and stays
   *  legible; the stamp only shows through blank space. */
  marcaDuplicado: string | null;
}

/** Display shape `ObservacionesFactura` draws — the Spanish-named
 *  on-page fields, kept distinct from `DescuentoProntoPago`
 *  (`common/facturacion/descuento-pronto-pago.util.ts`, the calculation's
 *  own English-named result) so the render layer never depends on that
 *  util's shape directly. */
export interface InfoDescuentoProntoPago {
  fechaLimite: Date;
  monto: number;
}

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
    fontFamily: 'Helvetica',
    marginTop: 4,
  },
});

/**
 * Shared body for Factura and Prefactura — the "Consulta/Listado de
 * Facturación"-style invoice layout the predecessor system used: a
 * per-concept "Saldo Anterior / Cargos del Mes / Nuevo Saldo" table, not a
 * generic line-item invoice — so the resident sees both what this document
 * charges AND their running balance per concept, exactly like the WebSaco
 * original. Composed from Bernardo's approved layout components
 * (`EncabezadoDocumento`, `DatosAdquiriente`, `CuerpoFactura`,
 * `ObservacionesFactura`). Returns page content only — `paginaFactura`
 * still appends the DIAN footer on top; `paginaPrefactura`
 * (`prefactura-pdf.ts`) uses this as-is.
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
    nombre:
      l.taxAmount > 0 ? `${l.conceptName} (${l.taxRate}%)` : l.conceptName,
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
 * One Factura's full page content (body + DIAN footer). Its output feeds two
 * consumers: `LotesFacturacionService.consolidar()` serializes it once, per
 * invoice, into the frozen `documentDefinition` the browser later renders
 * (see `serializarArbol`); `paginaPrefactura` (`prefactura-pdf.ts`) mirrors
 * its shape but is NOT built from it, since a prefactura has no real Factura
 * behind it yet.
 *
 * Accepts `FacturaLean` (not `FacturaDocument`) — a real hydrated document is
 * structurally assignable to the plain-fields lean shape, so this only reads
 * what it always read; widened so a whole lote's invoices (`.lean()`-fetched,
 * not hydrated) can be passed through just as easily as one at a time.
 */
export function paginaFactura(
  factura: FacturaLean,
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

  return createElement(
    View,
    null,
    contenidoDocumentoFacturacion(datos, copropiedad),
    pie,
  );
}

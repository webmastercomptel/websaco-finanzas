// src/modules/envio-facturas/envio-factura-correo.ts
import {
  renderCajaDetalle,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import { escapeHtml } from '../../common/correo/texto-correo';

/** What the "your invoice is ready" notice needs to say. Never amounts. */
export interface DatosCorreoFactura {
  nombreDestinatario: string;
  nombreCopropiedad: string;
  numeroCompleto: string;
  codigoInmueble: string;
  /** Billing period in words ("octubre de 2026"); empty when unknown. */
  periodo: string;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Billing period of an invoice in words, in UTC: `periodoDesde` is a calendar
 * date stored at UTC midnight, so a local-time formatter would show the
 * previous month in Bogotá.
 */
export const etiquetaPeriodo = (
  periodoDesde: Date | null | undefined,
): string =>
  periodoDesde
    ? new Intl.DateTimeFormat('es-CO', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(periodoDesde)
    : '';

/** Subject of the email and title of the in-app entry (plain text, not HTML). */
export const construirAsuntoFactura = (numeroCompleto: string): string =>
  `Tu factura ${numeroCompleto} ya está disponible`;

/**
 * Subject and HTML of the notice that tells the owner or tenant of a unit that an
 * invoice is available. The PDF is NOT attached and no amount is written: an
 * invoice holds financial data and an inbox is not a safe place for it, so the
 * button leads into the portal, where access is checked per unit. Every string
 * that is not ours is escaped here, in the one place that interpolates it.
 */
export const construirCorreoFactura = (
  datos: DatosCorreoFactura,
): { asunto: string; html: string } => {
  const numero = escapeHtml(datos.numeroCompleto);
  const periodo = datos.periodo
    ? ` correspondiente a <strong>${escapeHtml(datos.periodo)}</strong>`
    : '';
  return {
    asunto: construirAsuntoFactura(datos.numeroCompleto),
    html: renderPlantillaCorreo({
      heading: `Tu factura ${numero}`,
      bodyHtml: `
        <p style="margin: 0 0 16px;">
          ${escapeHtml(datos.nombreDestinatario)}, ya está disponible la factura <strong>${numero}</strong>${periodo} en ${escapeHtml(datos.nombreCopropiedad)}. Por seguridad no la adjuntamos: ingrese a WebSaco para verla y descargarla.
        </p>
        ${renderCajaDetalle(`<p style="margin: 0;">Inmueble: <strong>${escapeHtml(datos.codigoInmueble)}</strong></p>`)}
      `,
      cta: datos.enlace
        ? { url: datos.enlace, label: 'Ver mi factura' }
        : undefined,
    }),
  };
};

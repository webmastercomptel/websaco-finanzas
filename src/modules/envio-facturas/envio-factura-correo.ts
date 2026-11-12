// src/modules/envio-facturas/envio-factura-correo.ts
import {
  renderCajaDetalle,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import { escapeHtml } from '../../common/correo/texto-correo';

/** What the "your invoice is ready" e-mail needs to say. Never amounts. */
export interface DatosCorreoFactura {
  /** The party's display name (the record's, not an account's). */
  nombreDestinatario: string;
  nombreCopropiedad: string;
  numeroCompleto: string;
  codigoInmueble: string;
  /** Billing period in words ("octubre de 2026"); empty when unknown. */
  periodo: string;
  /** Public link to THIS invoice's PDF for THIS address (token in the fragment). */
  enlacePdf: string;
  /** Last day the link works, already written ("12 de diciembre de 2026"). */
  venceEl: string;
  /** Plain portal address for people who have an account; carries no token. */
  urlPortal: string;
}

/**
 * The public PDF link: `<origin>/factura#<token>`. The token travels in the
 * fragment, so it never reaches a server log, a proxy or a `Referer`; it is
 * never put in a path or a query string.
 */
export const construirEnlacePdf = (
  frontendUrl: string,
  token: string,
): string => {
  const url = new URL('/factura', frontendUrl);
  url.hash = token;
  return url.toString();
};

/** The portal's invoice list: a plain address, no token, no query. */
export const construirUrlPortal = (frontendUrl: string): string =>
  new URL('/portal/facturas', frontendUrl).toString();

/**
 * A link's last day in words, in Bogotá time ("12 de diciembre de 2026").
 * Bogotá, not UTC: an expiry at 02:00Z is still the previous day for the person
 * reading it.
 */
export const etiquetaFechaVencimiento = (expiraEn: Date): string =>
  new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Bogota',
  }).format(expiraEn);

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
 * Subject and HTML of the e-mail that tells a person on a unit's record that an
 * invoice is available. The PDF is NOT attached and no amount is written: the
 * button opens a personal link that serves that one PDF without an account, and
 * the text says when it stops working. No sign-in link is carried. Every string
 * that is not ours is escaped here, in the one place that interpolates it.
 */
export const construirCorreoFactura = (
  datos: DatosCorreoFactura,
): { asunto: string; html: string } => {
  const numero = escapeHtml(datos.numeroCompleto);
  const periodo = datos.periodo
    ? ` correspondiente a <strong>${escapeHtml(datos.periodo)}</strong>`
    : '';
  const portal = escapeHtml(datos.urlPortal);
  return {
    asunto: construirAsuntoFactura(datos.numeroCompleto),
    html: renderPlantillaCorreo({
      heading: `Tu factura ${numero}`,
      bodyHtml: `
        <p style="margin: 0 0 16px;">
          ${escapeHtml(datos.nombreDestinatario)}, ya está disponible la factura <strong>${numero}</strong>${periodo} en ${escapeHtml(datos.nombreCopropiedad)}. La factura no va adjunta: ábrela con el botón.
        </p>
        ${renderCajaDetalle(`<p style="margin: 0;">Inmueble: <strong>${escapeHtml(datos.codigoInmueble)}</strong></p>`)}
        <p style="margin: 0 0 16px;">
          Este enlace es personal; vence el ${escapeHtml(datos.venceEl)}.
        </p>
        <p style="margin: 0 0 24px; font-size: 13px;">
          Si tienes cuenta en WebSaco, también la encuentras en el portal: <a href="${portal}">${portal}</a>
        </p>
      `,
      cta: { url: datos.enlacePdf, label: 'Ver mi factura' },
    }),
  };
};

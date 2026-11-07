// src/modules/facturacion-bloque/bloque-correo.ts
import {
  renderCajaDetalle,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import { escapeHtml } from '../../common/correo/texto-correo';

const ETIQUETA_TIPO: Record<string, string> = {
  factura: 'factura',
  estado_cuenta: 'estado de cuenta',
  recibo: 'recibo',
};

/** Lower-case name of a document kind for running text; unknown kinds pass through. */
export const etiquetaDeTipo = (tipo: string): string =>
  ETIQUETA_TIPO[tipo] ?? tipo;

/**
 * Subject of the email, also the title of the in-app entry. Plain text (a
 * subject is not HTML), so it is not escaped. `periodo` is free text typed by an
 * admin, which is why the HTML parts below escape it.
 */
export const construirAsuntoBloque = (tipo: string, periodo: string): string =>
  `Tu ${etiquetaDeTipo(tipo)} de ${periodo} ya está disponible`;

/** What the "your document is ready" email needs to say. */
export interface DatosCorreoBloque {
  nombreDestinatario: string;
  nombreCopropiedad: string;
  tipo: string;
  periodo: string;
  codigoInmueble: string;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Subject and HTML of the email that tells a resident their document of a unit
 * is available. The PDF is NOT attached: it holds financial data and an inbox is
 * not a safe place for it, so the button leads into the portal. Every string
 * that is not ours (names, period, unit code) is escaped here, in the one place
 * that interpolates it into markup.
 */
export const construirCorreoBloque = (
  datos: DatosCorreoBloque,
): { asunto: string; html: string } => {
  const tipo = escapeHtml(etiquetaDeTipo(datos.tipo));
  const periodo = escapeHtml(datos.periodo);
  return {
    asunto: construirAsuntoBloque(datos.tipo, datos.periodo),
    html: renderPlantillaCorreo({
      heading: `Tu ${tipo} de ${periodo}`,
      bodyHtml: `
        <p style="margin: 0 0 16px;">
          ${escapeHtml(datos.nombreDestinatario)}, ya está disponible tu ${tipo} de <strong>${periodo}</strong> en ${escapeHtml(datos.nombreCopropiedad)}. Por seguridad no lo adjuntamos: ingresá a WebSaco para verlo y descargarlo.
        </p>
        ${renderCajaDetalle(`<p style="margin: 0;">Inmueble: <strong>${escapeHtml(datos.codigoInmueble)}</strong></p>`)}
      `,
      cta: datos.enlace
        ? { url: datos.enlace, label: 'Ver mi documento' }
        : undefined,
    }),
  };
};

// src/common/correo/plantilla-correo.ts
import { escapeHtml } from './texto-correo';

/**
 * The color system of every transactional email. A template file only ever
 * references these tokens, never a hex of its own: a different gray in every
 * template was the original complaint about the system this was ported from.
 */
export const COLORES_CORREO = {
  ink: '#111827', // headings
  body: '#374151', // paragraph text
  muted: '#6b7280', // secondary text
  faint: '#9ca3af', // fine print
  accent: '#0f766e', // CTA buttons, detail-box border
  border: '#e5e7eb',
  surface: '#f8fafc', // detail-box background
  page: '#f1f5f9', // backdrop behind the card
} as const;

interface ParametrosPlantilla {
  /** Already-escaped heading HTML. */
  heading: string;
  /** Already-escaped body HTML: the template-specific middle section. */
  bodyHtml: string;
  /**
   * A call-to-action button. `url` is trusted as already safe (an access link
   * built by `EnlaceAccesoService`, or a plain app link): never interpolate raw
   * user input into it. Omit it for a recipient with nowhere to sign in.
   */
  cta?: { url: string; label: string };
}

/** The one footer of every email: brand line plus the automated-message boilerplate. */
const PIE_HTML = `
  <p style="margin: 0 0 6px; color: ${COLORES_CORREO.muted}; font-size: 12px; font-weight: 600; line-height: 1.5;">
    WebSACO — el portal que comparte la información de gestión y financiera de su copropiedad.
  </p>
  <p style="margin: 0 0 12px; color: ${COLORES_CORREO.faint}; font-size: 11px; line-height: 1.5;">
    Este es un mensaje automático generado por WebSaco. Por favor, no respondas a este correo.
  </p>
  <p style="margin: 0; color: ${COLORES_CORREO.faint}; font-size: 11px; line-height: 1.5;">
    <strong>Confidencial:</strong> la información contenida en este email es confidencial y solo puede ser utilizada por el individuo al cual se está dirigiendo. Si por error recibe este mensaje, le ofrecemos disculpas y le agradecemos borrar el mensaje recibido inmediatamente.
  </p>
`;

/**
 * The visual shell of every transactional email: backdrop, bordered card with a
 * text wordmark (no inline image: nothing hosts the logo yet), heading, body,
 * optional button and footer. The single point of change for branding.
 */
export const renderPlantillaCorreo = ({
  heading,
  bodyHtml,
  cta,
}: ParametrosPlantilla): string => `
  <div style="background: ${COLORES_CORREO.page}; padding: 32px 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <div style="max-width: 520px; margin: 0 auto; background: #ffffff; border: 1px solid ${COLORES_CORREO.border}; border-radius: 16px; padding: 40px; color: ${COLORES_CORREO.body};">
      <p style="margin: 0 0 28px; color: ${COLORES_CORREO.accent}; font-size: 20px; font-weight: 800; letter-spacing: -0.01em;">WebSaco</p>

      <h1 style="margin: 0 0 20px; color: ${COLORES_CORREO.ink}; font-size: 22px; font-weight: 700; line-height: 1.3;">${heading}</h1>

      <div style="font-size: 15px; line-height: 1.6;">
        ${bodyHtml}
      </div>

      ${
        cta
          ? `<a href="${escapeHtml(cta.url)}" style="display: block; box-sizing: border-box; width: 100%; text-align: center; background: ${COLORES_CORREO.accent}; color: #ffffff; text-decoration: none; padding: 14px 24px; border-radius: 8px; font-size: 15px; font-weight: 600; margin: 4px 0 32px;">${cta.label}</a>`
          : ''
      }

      <div style="margin-top: ${cta ? '0' : '32px'}; padding-top: 24px; border-top: 1px solid ${COLORES_CORREO.border};">
        ${PIE_HTML}
      </div>
    </div>
  </div>
`;

/** A bordered, left-accented callout box for structured info (dates, priority, a quote). */
export const renderCajaDetalle = (innerHtml: string): string => `
  <div style="background: ${COLORES_CORREO.surface}; border-left: 3px solid ${COLORES_CORREO.accent}; border-radius: 8px; padding: 18px 20px; margin: 0 0 24px;">
    ${innerHtml}
  </div>
`;

/**
 * A label/value row inside `renderCajaDetalle`. `valor` must already be safe
 * HTML. Pass `esUltima` for the row that closes the box.
 */
export const renderFilaDetalle = (
  etiqueta: string,
  valor: string,
  esUltima?: boolean,
): string => `
  <div style="margin: 0 0 ${esUltima ? '0' : '14px'};">
    <p style="margin: 0 0 2px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: ${COLORES_CORREO.muted};">${etiqueta}</p>
    <p style="margin: 0; font-size: 14px; color: ${COLORES_CORREO.ink};">${valor}</p>
  </div>
`;

/** One muted byline ("Publicado por X · fecha"); falsy parts are dropped, '' if none survive. */
export const renderLineaMeta = (
  partes: (string | null | undefined | false)[],
): string => {
  const visibles = partes.filter((p): p is string => Boolean(p));
  if (visibles.length === 0) return '';
  return `<p style="margin: 0 0 16px; color: ${COLORES_CORREO.muted}; font-size: 12px; font-weight: 500;">${visibles.join('&nbsp;·&nbsp;')}</p>`;
};

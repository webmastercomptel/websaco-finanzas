// src/modules/anuncios/anuncio-correo.ts
import {
  renderCajaDetalle,
  renderLineaMeta,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import { escapeHtml, formatFecha } from '../../common/correo/texto-correo';

/**
 * Replaces `{{clave}}` placeholders with the given values; a placeholder with no
 * value is left as written, so a typo is visible instead of vanishing. Only OWN
 * keys of `valores` count: `{{constructor}}` must never resolve to something
 * inherited from `Object.prototype`.
 *
 * Works on PLAIN text and returns plain text: escaping happens exactly once, in
 * `construirCorreoAnuncio`, so a substituted value can neither inject markup nor
 * be escaped twice.
 */
export const compilarPlantilla = (
  plantilla: string,
  valores: Record<string, string>,
): string =>
  plantilla.replace(/\{\{(\w+)\}\}/g, (marcador, clave: string) =>
    Object.hasOwn(valores, clave) ? valores[clave] : marcador,
  );

/**
 * Personalizes an announcement body for one resident. `{{nombre}}` is the
 * documented placeholder; `{{name}}` is kept because content written in the
 * system this was ported from used it.
 */
export const personalizarContenido = (
  contenido: string,
  nombreResidente: string,
): string =>
  compilarPlantilla(contenido, {
    nombre: nombreResidente,
    name: nombreResidente,
  });

/** What the "new announcement" email needs to say. */
export interface DatosCorreoAnuncio {
  nombreCopropiedad: string;
  titulo: string;
  /** Already personalized, still PLAIN text (escaped here). */
  contenido: string;
  /** Empty when unknown: the "published by" part is then left out. */
  autor: string;
  fecha: Date;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Subject of the email, also used as the title of the in-app entry. Plain text:
 * a subject is not HTML, so it is not escaped.
 */
export const construirAsuntoAnuncio = (
  nombreCopropiedad: string,
  titulo: string,
): string => `Nuevo anuncio en ${nombreCopropiedad}: ${titulo}`;

/**
 * Subject and HTML of the email that carries an announcement to a resident.
 * Every user-typed string (title, body, author, and any name substituted into
 * the body) is escaped here, in the one place that interpolates it into markup.
 * The body is authored as plain text, so line breaks become `<br/>`.
 */
export const construirCorreoAnuncio = (
  datos: DatosCorreoAnuncio,
): { asunto: string; html: string } => ({
  asunto: construirAsuntoAnuncio(datos.nombreCopropiedad, datos.titulo),
  html: renderPlantillaCorreo({
    heading: escapeHtml(datos.titulo),
    bodyHtml: `
      ${renderLineaMeta([
        datos.autor ? `Publicado por ${escapeHtml(datos.autor)}` : null,
        escapeHtml(formatFecha(datos.fecha)),
      ])}
      ${renderCajaDetalle(escapeHtml(datos.contenido).replace(/\r?\n/g, '<br/>'))}
    `,
    cta: datos.enlace
      ? { url: datos.enlace, label: 'Ver el anuncio' }
      : undefined,
  }),
});

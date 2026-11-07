import {
  renderCajaDetalle,
  renderFilaDetalle,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import { escapeHtml } from '../../common/correo/texto-correo';

const ETIQUETA_TIPO: Record<string, string> = {
  peticiones: 'Petición',
  quejas: 'Queja',
  reclamos: 'Reclamo',
  sugerencias: 'Sugerencia',
  felicitaciones: 'Felicitación',
  denuncias: 'Denuncia',
};

const ETIQUETA_PRIORIDAD: Record<string, string> = {
  alta: 'Alta',
  media: 'Media',
  normal: 'Normal',
  baja: 'Baja',
};

/** Free text a person typed: escaped, with line breaks kept. */
const renderTexto = (texto: string): string =>
  escapeHtml(texto).replace(/\n/g, '<br/>');

/** What the "new PQR" email to staff needs to say. */
export interface DatosCorreoPqrNueva {
  nombreDestinatario: string;
  nombreCopropiedad: string;
  codigo: string;
  titulo: string;
  tipo: string;
  prioridad: string;
  unidad: string;
  residenteNombre: string;
  descripcion: string;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Subject and HTML of the email that tells staff a PQR was filed. Every
 * user-typed string is escaped here, in the one place that interpolates it into
 * markup.
 */
export const construirCorreoPqrNueva = (
  datos: DatosCorreoPqrNueva,
): { asunto: string; html: string } => ({
  asunto: `Nueva PQR en ${datos.nombreCopropiedad}: ${datos.codigo}`,
  html: renderPlantillaCorreo({
    heading: escapeHtml(datos.titulo),
    bodyHtml: `
      <p style="margin: 0 0 20px;">
        ${escapeHtml(datos.nombreDestinatario)}, se registró una nueva PQR en <strong>${escapeHtml(datos.nombreCopropiedad)}</strong>${datos.unidad ? `, unidad ${escapeHtml(datos.unidad)}` : ''}${datos.residenteNombre ? ` a nombre de ${escapeHtml(datos.residenteNombre)}` : ''}:
      </p>
      ${renderCajaDetalle(`
        ${renderFilaDetalle('Tipo', escapeHtml(ETIQUETA_TIPO[datos.tipo] ?? datos.tipo))}
        ${renderFilaDetalle('Prioridad', escapeHtml(ETIQUETA_PRIORIDAD[datos.prioridad] ?? datos.prioridad))}
        ${renderFilaDetalle('Código', escapeHtml(datos.codigo))}
        ${renderFilaDetalle('Descripción', renderTexto(datos.descripcion), true)}
      `)}
    `,
    cta: datos.enlace ? { url: datos.enlace, label: 'Ver la PQR' } : undefined,
  }),
});

/** What the "new reply on your PQR" email to the author needs to say. */
export interface DatosCorreoPqrRespuesta {
  nombreDestinatario: string;
  nombreCopropiedad: string;
  codigo: string;
  titulo: string;
  /** Who wrote the reply. */
  autor: string;
  mensaje: string;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/** Subject and HTML of the email that tells a PQR's author it got a reply. */
export const construirCorreoPqrRespuesta = (
  datos: DatosCorreoPqrRespuesta,
): { asunto: string; html: string } => ({
  asunto: `Nueva respuesta en tu PQR ${datos.codigo}`,
  html: renderPlantillaCorreo({
    heading: 'Nueva respuesta en tu PQR',
    bodyHtml: `
      <p style="margin: 0 0 20px;">
        ${escapeHtml(datos.nombreDestinatario)}, tu PQR "<strong>${escapeHtml(datos.titulo)}</strong>" (código ${escapeHtml(datos.codigo)}) en ${escapeHtml(datos.nombreCopropiedad)} tiene una respuesta nueva de ${escapeHtml(datos.autor)}:
      </p>
      ${renderCajaDetalle(renderTexto(datos.mensaje))}
    `,
    cta: datos.enlace
      ? { url: datos.enlace, label: 'Ver la respuesta' }
      : undefined,
  }),
});

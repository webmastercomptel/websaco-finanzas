// src/modules/actividades/actividad-correo.ts
import {
  renderCajaDetalle,
  renderFilaDetalle,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import { escapeHtml, formatDiaUtc } from '../../common/correo/texto-correo';

/** What the "new community activity" email needs to say. */
export interface DatosCorreoActividadNueva {
  nombreResidente: string;
  nombreCopropiedad: string;
  titulo: string;
  categoria: string;
  fecha: Date;
  horario: string;
  ubicacion: string;
  descripcion?: string;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Subject and HTML of the email that announces a new activity to a resident.
 * Every user-typed string is escaped here, in the one place that interpolates
 * it into markup.
 */
export const construirCorreoActividadNueva = (
  datos: DatosCorreoActividadNueva,
): { asunto: string; html: string } => {
  const filas = [
    ['Categoría', escapeHtml(datos.categoria)],
    ['Fecha', escapeHtml(formatDiaUtc(datos.fecha))],
    ['Horario', escapeHtml(datos.horario || 'Por confirmar')],
    ...(datos.ubicacion ? [['Ubicación', escapeHtml(datos.ubicacion)]] : []),
    ...(datos.descripcion
      ? [['Descripción', escapeHtml(datos.descripcion)]]
      : []),
  ];

  return {
    asunto: `Nueva actividad en ${datos.nombreCopropiedad}: ${datos.titulo}`,
    html: renderPlantillaCorreo({
      heading: escapeHtml(datos.titulo),
      bodyHtml: `
        <p style="margin: 0 0 20px;">
          ${escapeHtml(datos.nombreResidente)}, se programó una nueva actividad en ${escapeHtml(datos.nombreCopropiedad)}:
        </p>
        ${renderCajaDetalle(
          filas
            .map(([etiqueta, valor], i) =>
              renderFilaDetalle(etiqueta, valor, i === filas.length - 1),
            )
            .join(''),
        )}
      `,
      cta: datos.enlace
        ? { url: datos.enlace, label: 'Confirmar asistencia' }
        : undefined,
    }),
  };
};

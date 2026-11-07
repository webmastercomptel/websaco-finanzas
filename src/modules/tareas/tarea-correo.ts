// src/modules/tareas/tarea-correo.ts
import {
  renderCajaDetalle,
  renderFilaDetalle,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import { escapeHtml, formatFecha } from '../../common/correo/texto-correo';

/** What the "you were assigned a task" email needs to say. */
export interface DatosCorreoTareaAsignada {
  nombreAsignado: string;
  nombreCopropiedad: string;
  titulo: string;
  categoria: string;
  prioridad: string;
  descripcion?: string;
  fechaLimite?: Date | null;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Subject and HTML of the email that tells somebody a task landed on their
 * plate. Every user-typed string is escaped here, in the one place that
 * interpolates it into markup.
 */
export const construirCorreoTareaAsignada = (
  datos: DatosCorreoTareaAsignada,
): { asunto: string; html: string } => {
  const filas = [
    ['Categoría', escapeHtml(datos.categoria)],
    ['Prioridad', escapeHtml(datos.prioridad)],
    ...(datos.fechaLimite
      ? [['Fecha límite', escapeHtml(formatFecha(datos.fechaLimite))]]
      : []),
    ...(datos.descripcion
      ? [['Descripción', escapeHtml(datos.descripcion)]]
      : []),
  ];

  return {
    asunto: `Te asignaron una tarea en ${datos.nombreCopropiedad}: ${datos.titulo}`,
    html: renderPlantillaCorreo({
      heading: escapeHtml(datos.titulo),
      bodyHtml: `
        <p style="margin: 0 0 20px;">
          ${escapeHtml(datos.nombreAsignado)}, te asignaron esta tarea en ${escapeHtml(datos.nombreCopropiedad)}:
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
        ? { url: datos.enlace, label: 'Ver mi tarea' }
        : undefined,
    }),
  };
};

// src/modules/mantenimientos/mantenimiento-correo.ts
import {
  renderCajaDetalle,
  renderFilaDetalle,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import { escapeHtml, formatFecha } from '../../common/correo/texto-correo';

const ETIQUETA_TIPO: Record<string, string> = {
  preventivo: 'Mantenimiento preventivo',
  correctivo: 'Mantenimiento correctivo',
};

/** What the "a maintenance was assigned to you" email needs to say. */
export interface DatosCorreoMantenimientoAsignado {
  nombreTecnico: string;
  nombreCopropiedad: string;
  titulo: string;
  tipo: string;
  fecha: Date;
  horario: string | null;
  ubicacion: string;
  descripcion?: string;
}

/**
 * Subject and HTML of the email that tells a technician a job was scheduled
 * for them. Plain on purpose: no access link or button, because an external
 * technician usually has no account to sign in with. Every user-typed string
 * is escaped here, in the one place that interpolates it into markup.
 */
export const construirCorreoMantenimientoAsignado = (
  datos: DatosCorreoMantenimientoAsignado,
): { asunto: string; html: string } => {
  const filas = [
    ['Tipo', escapeHtml(ETIQUETA_TIPO[datos.tipo] ?? datos.tipo)],
    [
      'Fecha',
      `${escapeHtml(formatFecha(datos.fecha))}${datos.horario ? ` (${escapeHtml(datos.horario)})` : ''}`,
    ],
    ...(datos.descripcion ? [['Detalle', escapeHtml(datos.descripcion)]] : []),
  ];

  return {
    asunto: `Mantenimiento asignado en ${datos.nombreCopropiedad}: ${datos.titulo}`,
    html: renderPlantillaCorreo({
      heading: escapeHtml(datos.titulo),
      bodyHtml: `
        <p style="margin: 0 0 20px;">
          ${escapeHtml(datos.nombreTecnico)}, te asignaron este mantenimiento en <strong>${escapeHtml(datos.nombreCopropiedad)}</strong>${datos.ubicacion ? `, en ${escapeHtml(datos.ubicacion)}` : ''}:
        </p>
        ${renderCajaDetalle(
          filas
            .map(([etiqueta, valor], i) =>
              renderFilaDetalle(etiqueta, valor, i === filas.length - 1),
            )
            .join(''),
        )}
      `,
    }),
  };
};

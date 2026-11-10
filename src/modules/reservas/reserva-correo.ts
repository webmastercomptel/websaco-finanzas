// src/modules/reservas/reserva-correo.ts
import {
  renderCajaDetalle,
  renderFilaDetalle,
  renderPlantillaCorreo,
} from '../../common/correo/plantilla-correo';
import {
  escapeHtml,
  formatFechaRelojDePared,
} from '../../common/correo/texto-correo';

/** What the "new reservation request" email to staff needs to say. */
export interface DatosCorreoReservaNueva {
  nombreDestinatario: string;
  nombreCopropiedad: string;
  espacio: string;
  inicio: Date;
  fin: Date;
  residenteNombre: string;
  unidad: string;
  motivo?: string | null;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Subject and HTML of the email that tells staff a reservation needs an answer.
 * Every user-typed string is escaped here, in the one place that interpolates
 * it into markup.
 */
export const construirCorreoReservaNueva = (
  datos: DatosCorreoReservaNueva,
): { asunto: string; html: string } => {
  const filas = [
    [
      'Solicitante',
      `${escapeHtml(datos.residenteNombre)}${datos.unidad ? ` (unidad ${escapeHtml(datos.unidad)})` : ''}`,
    ],
    ['Desde', escapeHtml(formatFechaRelojDePared(datos.inicio))],
    ['Hasta', escapeHtml(formatFechaRelojDePared(datos.fin))],
    ...(datos.motivo ? [['Motivo', escapeHtml(datos.motivo)]] : []),
  ];

  return {
    asunto: `Nueva reserva pendiente en ${datos.nombreCopropiedad}: ${datos.espacio}`,
    html: renderPlantillaCorreo({
      heading: escapeHtml(datos.espacio),
      bodyHtml: `
        <p style="margin: 0 0 20px;">
          ${escapeHtml(datos.nombreDestinatario)}, ${escapeHtml(datos.residenteNombre)} solicitó reservar este espacio:
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
        ? { url: datos.enlace, label: 'Aprobar o rechazar' }
        : undefined,
    }),
  };
};

/** How staff answered a reservation. */
export type RespuestaReserva = 'aprobada' | 'rechazada' | 'cancelada';

/** What the "your reservation was answered" email needs to say. */
export interface DatosCorreoReservaRespuesta {
  nombreDestinatario: string;
  nombreCopropiedad: string;
  espacio: string;
  inicio: Date;
  fin: Date;
  respuesta: RespuestaReserva;
  /** Access link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

const ASUNTO_RESPUESTA: Record<RespuestaReserva, string> = {
  aprobada: 'fue aprobada',
  rechazada: 'fue rechazada',
  cancelada: 'fue cancelada',
};

const ENCABEZADO_RESPUESTA: Record<RespuestaReserva, string> = {
  aprobada: 'Reserva aprobada',
  rechazada: 'Reserva rechazada',
  cancelada: 'Reserva cancelada',
};

const VERBO_RESPUESTA: Record<RespuestaReserva, string> = {
  aprobada: '<strong style="color: #16a34a;">aprobada</strong>',
  rechazada: '<strong style="color: #dc2626;">rechazada</strong>',
  cancelada: '<strong style="color: #dc2626;">cancelada</strong>',
};

/**
 * Subject and HTML of the email that tells whoever requested a reservation that
 * staff approved, rejected or cancelled it. Approve/reject copy is the original
 * one; the cancelled variant is new (the original never told anyone about a
 * cancellation).
 */
export const construirCorreoReservaRespuesta = (
  datos: DatosCorreoReservaRespuesta,
): { asunto: string; html: string } => ({
  asunto: `Tu reserva de ${datos.espacio} ${ASUNTO_RESPUESTA[datos.respuesta]}`,
  html: renderPlantillaCorreo({
    heading: ENCABEZADO_RESPUESTA[datos.respuesta],
    bodyHtml: `
      <p style="margin: 0 0 20px;">
        ${escapeHtml(datos.nombreDestinatario)}, tu reserva de <strong>${escapeHtml(datos.espacio)}</strong> en ${escapeHtml(datos.nombreCopropiedad)} fue
        ${VERBO_RESPUESTA[datos.respuesta]}.
      </p>
      ${renderCajaDetalle(
        `${renderFilaDetalle('Desde', escapeHtml(formatFechaRelojDePared(datos.inicio)))}${renderFilaDetalle('Hasta', escapeHtml(formatFechaRelojDePared(datos.fin)), true)}`,
      )}
    `,
    cta: datos.enlace
      ? { url: datos.enlace, label: 'Ver mi reserva' }
      : undefined,
  }),
});

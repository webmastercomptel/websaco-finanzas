// src/modules/acceso-residentes/invitacion-correo.ts
import { renderPlantillaCorreo } from '../../common/correo/plantilla-correo';
import { escapeHtml } from '../../common/correo/texto-correo';

/** What the invitation email needs to say. */
export interface DatosCorreoInvitacion {
  nombre: string;
  nombreCopropiedad: string;
  /** Resident (owner/tenant) or back-office staff: only changes one sentence. */
  tipo: 'residente' | 'personal';
  /** True when the person already had a WebSaco account (the usual password still works). */
  cuentaExistente: boolean;
  /** Sign-in link for the button; null when none may be issued (no button then). */
  enlace: string | null;
}

/**
 * Subject and HTML of the email that tells somebody they now have access.
 *
 * It carries NO password, ever. The identity is created with a random one that
 * nobody sees (the source system emailed generated passwords, which left a live
 * credential in an inbox); the person gets in through the button, which lands
 * them signed in, and chooses their own password from the app, or later through
 * the sign-in page's "forgot my password". When no button could be issued the
 * message says how to get in without one, so the email is never a dead end.
 *
 * Every user-typed string is escaped here, in the one place that interpolates
 * it into markup.
 */
export const construirCorreoInvitacion = (
  datos: DatosCorreoInvitacion,
): { asunto: string; html: string } => {
  const rol =
    datos.tipo === 'residente'
      ? 'consultar la información de tu inmueble'
      : 'trabajar con el equipo de la copropiedad';

  const entrada = datos.enlace
    ? 'Usa el botón de abajo para entrar: no necesitas ninguna contraseña para esta primera vez. Una vez dentro podrás definir la tuya desde la aplicación.'
    : 'Para entrar, abre la página de inicio de sesión de WebSaco e indica este mismo correo. Si aún no tienes contraseña, usa la opción «Olvidé mi contraseña» para elegir una.';

  const cuenta = datos.cuentaExistente
    ? '<p style="margin: 0 0 20px;">Ya tenías una cuenta con este correo, así que puedes seguir usando tu contraseña de siempre.</p>'
    : '';

  return {
    asunto: `Ya tienes acceso a WebSaco en ${datos.nombreCopropiedad}`,
    html: renderPlantillaCorreo({
      heading: `Ya tienes acceso a ${escapeHtml(datos.nombreCopropiedad)}`,
      bodyHtml: `
        <p style="margin: 0 0 20px;">
          ${escapeHtml(datos.nombre)}, la administración de <strong>${escapeHtml(datos.nombreCopropiedad)}</strong> te dio acceso a WebSaco para ${rol}.
        </p>
        ${cuenta}
        <p style="margin: 0 0 20px;">${entrada}</p>
      `,
      cta: datos.enlace
        ? { url: datos.enlace, label: 'Entrar a WebSaco' }
        : undefined,
    }),
  };
};

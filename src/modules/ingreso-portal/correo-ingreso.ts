// src/modules/ingreso-portal/correo-ingreso.ts
import { renderPlantillaCorreo } from '../../common/correo/plantilla-correo';
import { VIGENCIA_ENLACE_INGRESO_MS } from './ingreso-portal.constantes';

/** What the sign-in e-mail needs. The link is the only variable part. */
export interface DatosCorreoIngreso {
  /** `<origin>/ingreso#<token>`; the token only ever travels inside this. */
  enlace: string;
  /** Lifetime to announce; defaults to the real one so text and rule agree. */
  vigenciaMs?: number;
  /**
   * The account behind the address signs in with its password (staff with
   * Finanzas keys, a platform-managed access or a platform admin: the shared
   * link policy). The same link then only CONFIRMS the address, so the copy
   * says so instead of promising a session it will not open.
   */
  conContrasena?: boolean;
}

/**
 * Subject and HTML of the e-mail that carries a resident's sign-in link.
 *
 * Deliberately says nothing about WHO the person is or what they hold: no name
 * (an address can sit on several records), no amount, no unit, no invoice. The
 * message goes to an address staff or the person typed, so everything it
 * contains must be harmless in the wrong inbox. The button is the only place the
 * link appears, and it is the fragment link of the `/ingreso` page, never a
 * session link (`/auth/enlace`) and never a token in a query string.
 *
 * The expiry sentence is derived from `VIGENCIA_ENLACE_INGRESO_MS`, so changing
 * the constant changes the promise.
 */
export const construirCorreoIngreso = (
  datos: DatosCorreoIngreso,
): { asunto: string; html: string } => {
  const minutos = Math.round(
    (datos.vigenciaMs ?? VIGENCIA_ENLACE_INGRESO_MS) / 60_000,
  );
  if (datos.conContrasena) {
    return {
      asunto: 'Confirma tu correo en WebSaco',
      html: renderPlantillaCorreo({
        heading: 'Confirma tu correo',
        bodyHtml: `
        <p style="margin: 0 0 20px;">
          Este correo pertenece a una cuenta del equipo de administración de WebSaco. Por seguridad, esa cuenta entra con su correo y contraseña.
        </p>
        <p style="margin: 0 0 20px;">
          Usa el botón de abajo para confirmar tu correo: así, cuando entres con tu contraseña, también verás tus inmuebles como propietario o arrendatario. El enlace vence en ${minutos} minutos.
        </p>
        <p style="margin: 0 0 20px; font-size: 13px;">
          Si no fuiste tú, puedes ignorar este mensaje: no pasa nada si no lo usas.
        </p>
      `,
        cta: { url: datos.enlace, label: 'Confirmar mi correo' },
      }),
    };
  }
  return {
    asunto: 'Tu enlace para entrar a WebSaco',
    html: renderPlantillaCorreo({
      heading: 'Entra a tu portal',
      bodyHtml: `
        <p style="margin: 0 0 20px;">
          Pediste entrar a tu portal de WebSaco. Usa el botón de abajo para entrar: no necesitas contraseña.
        </p>
        <p style="margin: 0 0 20px;">
          Este enlace es solo para ti y vence en ${minutos} minutos.
        </p>
        <p style="margin: 0 0 20px; font-size: 13px;">
          Si no fuiste tú, puedes ignorar este mensaje: no pasa nada si no lo usas.
        </p>
      `,
      cta: { url: datos.enlace, label: 'Entrar a mi portal' },
    }),
  };
};

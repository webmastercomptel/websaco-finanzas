// src/modules/ingreso-portal/correo-ingreso.ts
import { renderPlantillaCorreo } from '../../common/correo/plantilla-correo';
import { VIGENCIA_ENLACE_INGRESO_MS } from './ingreso-portal.constantes';

/** What the sign-in e-mail needs. The link is the only variable part. */
export interface DatosCorreoIngreso {
  /** `<origin>/ingreso#<token>`; the token only ever travels inside this. */
  enlace: string;
  /** Lifetime to announce; defaults to the real one so text and rule agree. */
  vigenciaMs?: number;
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
  return {
    asunto: 'Tu enlace para entrar a WebSaco',
    html: renderPlantillaCorreo({
      heading: 'Entra a tu portal',
      bodyHtml: `
        <p style="margin: 0 0 20px;">
          Pediste entrar a tu portal de WebSaco. Usa el botón de abajo para entrar: no necesitas contraseña.
        </p>
        <p style="margin: 0 0 20px;">
          Este enlace sirve una sola vez y vence en ${minutos} minutos.
        </p>
        <p style="margin: 0 0 20px; font-size: 13px;">
          Si no fuiste tú, puedes ignorar este mensaje: no pasa nada si no lo usas.
        </p>
      `,
      cta: { url: datos.enlace, label: 'Entrar a mi portal' },
    }),
  };
};

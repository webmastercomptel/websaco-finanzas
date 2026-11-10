// src/common/correo/logo-correo.ts
import { logoBytesWebsaco } from '../pdf/react/logo-websaco';

/**
 * Content-ID the email template references as `cid:logo-websaco`. The mailer
 * attaches the logo inline under this same id whenever the HTML mentions it, so
 * no caller has to know the logo exists.
 */
export const LOGO_CORREO_CID = 'logo-websaco';

/** Marker the mailer looks for in the HTML to decide to attach the logo. */
export const REFERENCIA_LOGO_CORREO = `cid:${LOGO_CORREO_CID}`;

/** The inline logo as the mailer attaches it. */
export interface LogoInlineCorreo {
  nombre: string;
  tipo: string;
  contenido: Buffer;
  idContenido: string;
}

/**
 * Nothing hosts the logo and a localhost link is dead in a mail client, so it
 * travels inside the message. The bytes come from the same single-read cache the
 * PDF renderers use (`logoBytesWebsaco`), so it is read from disk once per
 * process, never once per email.
 */
export const logoInlineCorreo = (): LogoInlineCorreo => ({
  nombre: 'websaco-logo.png',
  tipo: 'image/png',
  contenido: logoBytesWebsaco(),
  idContenido: LOGO_CORREO_CID,
});

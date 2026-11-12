// src/common/correo/correo.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// `@sendgrid/mail` exports a class instance whose methods live on the
// prototype — SWC's `import * as` interop only copies own properties, so
// `setApiKey`/`send` come back undefined at runtime (type-checks fine, crashes
// on boot). `import ... = require(...)` is a real `require()` with no interop
// wrapping. The lint rule against `require()` imports exists to push people to
// ES imports, which is exactly the form that breaks here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import sgMail = require('@sendgrid/mail');
import { enmascararEmail } from '../utils/email.utils';
import { logoInlineCorreo, REFERENCIA_LOGO_CORREO } from './logo-correo';

/** Anything shaped like an address inside a provider's error text. */
const PATRON_DIRECCION = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;]+/g;

/**
 * A file attached to an outgoing email. With `idContenido` it is sent inline
 * (referenced from the HTML as `cid:<idContenido>`) instead of as a download.
 */
export interface AdjuntoCorreo {
  nombre: string;
  tipo: string;
  contenido: Buffer;
  idContenido?: string;
}

/** One outgoing email. */
export interface MensajeCorreo {
  para: string;
  asunto: string;
  html: string;
  adjuntos?: AdjuntoCorreo[];
  /**
   * When true no log line names the recipient (not even masked) and the
   * provider's error text is left out of the log, since it often echoes the
   * address. For flows where the fact that an address was written to at all is
   * sensitive, like the resident sign-in request.
   */
  sinRegistrarDestinatario?: boolean;
}

/**
 * Sends email through SendGrid, the only channel the unified system uses.
 *
 * `enviar` never throws: a delivery failure is logged and reported as `false`,
 * so the caller decides what it means (mark the item as failed, retry later)
 * instead of a mail outage failing the request that triggered it. When the
 * environment has no SendGrid settings the service reports itself as not
 * configured and every send answers `false` — readiness (`correo.health.ts`)
 * is where that is made loud.
 */
@Injectable()
export class CorreoService {
  private readonly logger = new Logger(CorreoService.name);
  private readonly remitente: { email: string; name: string } | null;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('app.sendgridApiKey');
    const email = config.get<string>('app.sendgridFromEmail');
    const name = config.get<string>('app.sendgridFromName');
    if (apiKey && email && name) {
      sgMail.setApiKey(apiKey);
      this.remitente = { email, name };
    } else {
      this.remitente = null;
    }
  }

  /** True when the environment carries a SendGrid key and a sender. */
  estaConfigurado(): boolean {
    return this.remitente !== null;
  }

  /** Sends one email; `true` when SendGrid accepted it. Never throws. */
  async enviar(mensaje: MensajeCorreo): Promise<boolean> {
    if (!this.remitente) {
      this.logger.error(
        `No se pudo enviar el correo${this.destinatarioParaRegistro(mensaje)}: SendGrid no está configurado (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL).`,
      );
      return false;
    }
    try {
      await sgMail.send({
        to: mensaje.para,
        from: this.remitente,
        subject: mensaje.asunto,
        html: mensaje.html,
        // Many of these emails carry an access link, which is a bearer
        // credential: click tracking would rewrite it through SendGrid's
        // redirect domain (and log it there), open tracking adds a pixel.
        // Off per message, whatever the account default says.
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
          openTracking: { enable: false },
        },
        attachments: this.adjuntosParaEnvio(mensaje)?.map((adjunto) => ({
          content: adjunto.contenido.toString('base64'),
          filename: adjunto.nombre,
          type: adjunto.tipo,
          ...(adjunto.idContenido
            ? { disposition: 'inline', content_id: adjunto.idContenido }
            : { disposition: 'attachment' }),
        })),
      });
      return true;
    } catch (error: unknown) {
      this.logger.error(
        mensaje.sinRegistrarDestinatario
          ? 'Falló el envío de un correo (destinatario y detalle omitidos a propósito).'
          : `Falló el envío del correo${this.destinatarioParaRegistro(mensaje)}: ${this.sinDirecciones((error as Error).message)}`,
      );
      return false;
    }
  }

  /** " a a***@x.com", or nothing when the message asks not to be traced. */
  private destinatarioParaRegistro(mensaje: MensajeCorreo): string {
    return mensaje.sinRegistrarDestinatario
      ? ''
      : ` a ${enmascararEmail(mensaje.para)}`;
  }

  /**
   * Masks every address inside a provider's error text: SendGrid often echoes
   * the recipient, and the log must never hold a complete address.
   */
  private sinDirecciones(texto: string): string {
    return String(texto).replace(PATRON_DIRECCION, (direccion) =>
      enmascararEmail(direccion),
    );
  }

  /**
   * The message's own attachments plus, when the HTML shows the template's
   * `cid:` logo, that logo inline — so every templated email carries it with no
   * change in its caller. `undefined` (not `[]`) when there is nothing to attach.
   */
  private adjuntosParaEnvio(
    mensaje: MensajeCorreo,
  ): AdjuntoCorreo[] | undefined {
    const adjuntos = mensaje.adjuntos ?? [];
    const conLogo = mensaje.html.includes(REFERENCIA_LOGO_CORREO)
      ? [...adjuntos, logoInlineCorreo()]
      : adjuntos;
    return conLogo.length > 0 ? conLogo : undefined;
  }
}

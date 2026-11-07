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

/** A file attached to an outgoing email. */
export interface AdjuntoCorreo {
  nombre: string;
  tipo: string;
  contenido: Buffer;
}

/** One outgoing email. */
export interface MensajeCorreo {
  para: string;
  asunto: string;
  html: string;
  adjuntos?: AdjuntoCorreo[];
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
        `No se pudo enviar el correo a ${mensaje.para}: SendGrid no está configurado (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL).`,
      );
      return false;
    }
    try {
      await sgMail.send({
        to: mensaje.para,
        from: this.remitente,
        subject: mensaje.asunto,
        html: mensaje.html,
        attachments: mensaje.adjuntos?.map((adjunto) => ({
          content: adjunto.contenido.toString('base64'),
          filename: adjunto.nombre,
          type: adjunto.tipo,
          disposition: 'attachment',
        })),
      });
      return true;
    } catch (error: unknown) {
      this.logger.error(
        `Falló el envío del correo a ${mensaje.para}: ${(error as Error).message}`,
      );
      return false;
    }
  }
}

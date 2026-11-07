import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from '@nestjs/terminus';

/** What the indicator reports when no email settings are present. */
export const MOTIVO_CORREO_DESHABILITADO = 'correo no configurado';

const FORMATO_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Problems of the SendGrid settings, in Spanish and by SETTING NAME only: the
 * values (the API key, the sender address) never appear in the text, because
 * `/health/ready` is public and unauthenticated.
 *
 * Pure, so each rule has a spec without a Nest context. Empty list = fine.
 * Both settings unset is NOT handled here: that is "email off", not a
 * misconfiguration, and the indicator reports it separately. The Joi `.and()`
 * already stops the boot on a half-set pair; this is belt and braces so
 * readiness does not depend on that rule staying in `env.validation.ts`.
 *
 * It never calls SendGrid: whether the sender is a verified identity cannot be
 * known without a network call, which a readiness probe must not make.
 */
export function problemasConfiguracionCorreo(
  apiKey: string | undefined,
  remitente: string | undefined,
): string[] {
  const problemas: string[] = [];
  if (apiKey && !remitente) {
    problemas.push(
      'Falta SENDGRID_FROM_EMAIL: está definida SENDGRID_API_KEY pero no el correo remitente, así que SendGrid rechazará cada envío',
    );
  }
  if (remitente && !apiKey) {
    problemas.push(
      'Falta SENDGRID_API_KEY: está definido SENDGRID_FROM_EMAIL pero no la clave de SendGrid, así que no sale ningún correo',
    );
  }
  if (remitente && !FORMATO_CORREO.test(remitente)) {
    problemas.push('SENDGRID_FROM_EMAIL no es una dirección de correo válida');
  }
  return problemas;
}

/**
 * Terminus health indicator for the per-environment email settings. A missing
 * or half-set key used to surface only when the first real send failed;
 * readiness is where a missed step must be loud (see "Non-negotiable rules" in
 * CLAUDE.md).
 *
 * Neither setting present → `up`, reported as skipped (an environment that
 * sends no email must not be held back by it). Consistent → `up`. Half set or
 * malformed → `down`, naming the setting. Configuration only; no network.
 */
@Injectable()
export class CorreoHealthIndicator extends HealthIndicator {
  constructor(private readonly config: ConfigService) {
    super();
  }

  check(key: string): HealthIndicatorResult {
    const apiKey = this.config.get<string>('app.sendgridApiKey');
    const remitente = this.config.get<string>('app.sendgridFromEmail');

    if (!apiKey && !remitente) {
      return this.getStatus(key, true, {
        omitido: MOTIVO_CORREO_DESHABILITADO,
      });
    }

    const problemas = problemasConfiguracionCorreo(apiKey, remitente);
    if (problemas.length > 0) {
      const mensaje = problemas.join('; ');
      throw new HealthCheckError(
        mensaje,
        this.getStatus(key, false, { message: mensaje }),
      );
    }
    return this.getStatus(key, true);
  }
}

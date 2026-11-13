// src/modules/health/frontend-url.health.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { MOTIVO_CORREO_DESHABILITADO } from './correo.health';

/** Why `FRONTEND_URL` cannot be used to build an invoice link. */
export type DiagnosticoFrontendUrl = 'falta' | 'malformada';

/**
 * Judges `FRONTEND_URL` for the invoice links: it must be a bare http(s)
 * origin. A path, query, fragment or credentials would end up inside every
 * link (or leak a secret), so they count as malformed. Pure, with no network
 * and no echo of the value. `null` = usable.
 */
export function diagnosticarFrontendUrl(
  valor: string | undefined,
): DiagnosticoFrontendUrl | null {
  const texto = valor?.trim();
  if (!texto) return 'falta';
  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return 'malformada';
  }
  const origenSolo =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    !texto.includes('?') &&
    !texto.includes('#');
  return origenSolo ? null : 'malformada';
}

/**
 * The problems of `FRONTEND_URL`, in Spanish and by SETTING NAME only: the
 * value never appears, because `/health/ready` is public. Empty = fine.
 */
export function problemasFrontendUrl(valor: string | undefined): string[] {
  const diagnostico = diagnosticarFrontendUrl(valor);
  if (diagnostico === 'falta') {
    return [
      'Falta FRONTEND_URL: el envío de facturas no puede construir enlaces',
    ];
  }
  if (diagnostico === 'malformada') {
    return [
      'FRONTEND_URL debe ser solo la dirección pública de la aplicación (esquema y dominio, sin ruta, parámetros ni credenciales)',
    ];
  }
  return [];
}

/**
 * Readiness check for the setting the invoice e-mail's link is built from
 * (see "Pasos por ambiente" in CLAUDE.md, rule 10). An environment that sends
 * no e-mail is not held back by it (`up`, skipped); with mail configured, a
 * missing or malformed `FRONTEND_URL` is `down`, naming the setting.
 * Configuration only; no network.
 */
@Injectable()
export class FrontendUrlHealthIndicator extends HealthIndicator {
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

    const problemas = problemasFrontendUrl(
      this.config.get<string>('app.frontendUrl'),
    );
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

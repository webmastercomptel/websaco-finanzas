import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthCheckError,
  HealthIndicator,
  type HealthIndicatorResult,
} from '@nestjs/terminus';

/** What the indicator reports when the integration is switched off. */
export const MOTIVO_INTEGRACION_DESHABILITADA = 'integración deshabilitada';

/** Path suffix every Comptable API route lives under; part of the base URL. */
const PREFIJO_API_COMPTABLE = '/api/v1';

/**
 * Problems of the Comptable integration settings, in Spanish and by SETTING
 * NAME only: the values (a URL with a host, the shared secret) never appear in
 * the text, because `/health/ready` is public and unauthenticated.
 *
 * Pure, so each rule has a spec without a Nest context. Empty list = fine.
 * Both settings unset is NOT handled here: that is "integration off", not a
 * misconfiguration, and the indicator reports it separately.
 *
 * What it covers, and why only this:
 * - One setting without the other. Joi's `.and()` already stops the boot for
 *   this, so it is a belt-and-braces check: readiness must not depend on that
 *   rule staying in `env.validation.ts`.
 * - A URL that is not an absolute URL, carries credentials, a query or a
 *   fragment. `ComptableClient` builds `${base}/${route}` and signs the
 *   pathname + query of the result, so a query or fragment in the base would
 *   corrupt every request and every signature.
 * - A URL whose path does not end in `/api/v1`. Joi only checks the scheme, so
 *   this is the mistake nothing else catches: the runbook says the value must
 *   INCLUDE the prefix, and without it every route 404s, which Finanzas then
 *   reports as a missing Empresa rather than a bad URL.
 *
 * It does not check the secret's length (Joi requires 32+) and never compares
 * it with Comptable's: that would need a network call, which a readiness probe
 * must not make.
 */
export function problemasConfiguracionComptable(
  url: string | undefined,
  secreto: string | undefined,
): string[] {
  const problemas: string[] = [];
  if (url && !secreto) {
    problemas.push(
      'Falta COMPTABLE_HMAC_SECRET: está definida COMPTABLE_API_URL pero no el secreto compartido con Comptable, así que cada envío será rechazado',
    );
  }
  if (secreto && !url) {
    problemas.push(
      'Falta COMPTABLE_API_URL: está definido COMPTABLE_HMAC_SECRET pero no la dirección de Comptable (debe ser https://<host>/api/v1)',
    );
  }
  if (!url) return problemas;

  let direccion: URL | null = null;
  try {
    direccion = new URL(url);
  } catch {
    // Reported below, with the protocol case.
  }
  if (!direccion || !['http:', 'https:'].includes(direccion.protocol)) {
    problemas.push(
      'COMPTABLE_API_URL no es una URL http(s) válida: debe ser https://<host>/api/v1',
    );
    return problemas;
  }
  if (direccion.username || direccion.password) {
    problemas.push(
      'COMPTABLE_API_URL no debe llevar usuario ni contraseña: la autenticación va en la firma con COMPTABLE_HMAC_SECRET',
    );
  }
  if (direccion.search || direccion.hash) {
    problemas.push(
      'COMPTABLE_API_URL no debe llevar query (?...) ni fragmento (#...): debe ser https://<host>/api/v1',
    );
  }
  const ruta = direccion.pathname.replace(/\/+$/, '');
  if (!ruta.endsWith(PREFIJO_API_COMPTABLE)) {
    problemas.push(
      `COMPTABLE_API_URL debe terminar en ${PREFIJO_API_COMPTABLE} (https://<host>${PREFIJO_API_COMPTABLE}): sin ese prefijo las rutas de Comptable no existen (404)`,
    );
  }
  return problemas;
}

/**
 * Terminus health indicator for the per-environment configuration Finanzas
 * needs to talk to Comptable. Finanzas has no seeded account like Comptable
 * does; what can silently break its side of the integration is a URL or a
 * shared secret that is wrong or half set, and nothing said so until a real
 * send failed. Readiness is where a missed step must be loud — see
 * "Non-negotiable rules" in CLAUDE.md.
 *
 * Three states, never mixed up:
 * - Neither `COMPTABLE_API_URL` nor `COMPTABLE_HMAC_SECRET` set (integration
 *   off; most clients do not use it) → `up`, reported as skipped. An
 *   environment without the integration must not be held back by it.
 * - Settings present and consistent → `up`.
 * - Settings half set or malformed → `down`, naming the setting and what to fix.
 *
 * Reads configuration only: it never calls Comptable. A readiness probe is hit
 * every few seconds by the platform; making it depend on (or hammer) another
 * service would turn that service's outage into this one's.
 */
@Injectable()
export class IntegracionComptableHealthIndicator extends HealthIndicator {
  constructor(private readonly config: ConfigService) {
    super();
  }

  check(key: string): HealthIndicatorResult {
    const url = this.config.get<string>('app.comptableApiUrl');
    const secreto = this.config.get<string>('app.comptableHmacSecret');

    if (!url && !secreto) {
      return this.getStatus(key, true, {
        omitido: MOTIVO_INTEGRACION_DESHABILITADA,
      });
    }

    const problemas = problemasConfiguracionComptable(url, secreto);
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

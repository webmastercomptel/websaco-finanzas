// src/modules/publicacion-facturas/publicacion-facturas.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';

const HEADER = 'x-scheduler-secret';

/**
 * Protects `POST /interno/publicacion-facturas/procesar-pendientes` — the
 * ONLY guard this route has (see design.md's "Trigger controller" section
 * for why `FirebaseAuthGuard`/`PoliciesGuard` do not apply: the caller is
 * Cloud Scheduler, machine-to-machine, with no user and no tenant).
 *
 * Fails CLOSED: a missing configured secret is treated the same as a wrong
 * header, never as "open". Every failure returns the same opaque 401 — same
 * policy as `FirebaseAuthGuard` — and the reason goes only to the log. The
 * header value itself is never logged.
 *
 * Hashing both sides before `timingSafeEqual` equalizes their length so the
 * comparison can never throw on a length mismatch, and the caller learns
 * nothing about the real secret's length from a thrown-vs-compared
 * distinction.
 */
@Injectable()
export class SecretoProgramadorGuard implements CanActivate {
  private readonly logger = new Logger(SecretoProgramadorGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const esperado = this.config.get<string>(
      'app.websaco3PublicacionTriggerSecret',
    );
    if (!esperado) {
      this.logger.warn(
        'WEBSACO3_PUBLICACION_TRIGGER_SECRET no está configurado; se rechaza toda llamada al trigger.',
      );
      throw new UnauthorizedException();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[HEADER];
    const recibido = Array.isArray(header) ? header[0] : header;
    if (typeof recibido !== 'string' || recibido.length === 0) {
      this.logger.warn('Llamada al trigger sin el header X-Scheduler-Secret.');
      throw new UnauthorizedException();
    }

    const hashEsperado = createHash('sha256').update(esperado).digest();
    const hashRecibido = createHash('sha256').update(recibido).digest();
    if (!timingSafeEqual(hashEsperado, hashRecibido)) {
      this.logger.warn('Llamada al trigger con un secreto incorrecto.');
      throw new UnauthorizedException();
    }

    return true;
  }
}

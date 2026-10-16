// src/modules/integraciones-websaco3/firma-websaco3.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { hmacHexEquals, hmacSha256Hex } from '../../common/utils/hmac';
import {
  VENTANA_SEGUNDOS,
  cadenaFirmaPropietarios,
  rutaYConsulta,
} from './propietarios.firma';

const HEADER_TIMESTAMP = 'x-websaco-timestamp';
const HEADER_FIRMA = 'x-websaco-signature';
const PATRON_TIMESTAMP = /^\d{1,12}$/;
const PATRON_FIRMA = /^sha256=([0-9a-f]{64})$/;

/**
 * Authenticates the inbound WebSaco3 holders pull by verifying a
 * purpose-bound HMAC over method, full path and canonical query (see
 * `propietarios.firma.ts`). It is the ONLY guard of that route: the caller is
 * a machine with no user and no tenant, same reasoning as
 * `SecretoProgramadorGuard`.
 *
 * Guards run before pipes, so a bad signature answers 401 even with a
 * malformed query — an unsigned caller never learns whether an id is well
 * formed or exists.
 *
 * Fails CLOSED and OPAQUE: an unset/blank secret, a missing, duplicated or
 * malformed header, a stale timestamp and a wrong signature all throw the
 * same bare `UnauthorizedException`. The reason (and only the reason) goes to
 * the log: never a header value, the secret, the signature or the URL.
 */
@Injectable()
export class FirmaWebsaco3Guard implements CanActivate {
  private readonly logger = new Logger(FirmaWebsaco3Guard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secreto = this.config.get<string>('app.websaco3HmacSecret');
    if (typeof secreto !== 'string' || secreto.trim().length === 0) {
      return this.rechazar('WEBSACO3_HMAC_SECRET no está configurado');
    }

    const request = context.switchToHttp().getRequest<Request>();

    const timestamp = this.headerUnico(request, HEADER_TIMESTAMP);
    const firma = this.headerUnico(request, HEADER_FIRMA);
    if (timestamp === null || firma === null) {
      return this.rechazar('falta un header o está duplicado');
    }

    if (!PATRON_TIMESTAMP.test(timestamp)) {
      return this.rechazar('timestamp con formato inválido');
    }
    const ahoraSegundos = Math.floor(Date.now() / 1000);
    if (Math.abs(ahoraSegundos - Number(timestamp)) > VENTANA_SEGUNDOS) {
      return this.rechazar('timestamp fuera de la ventana permitida');
    }

    const coincidencia = PATRON_FIRMA.exec(firma);
    if (!coincidencia) {
      return this.rechazar('firma con formato inválido');
    }

    let esperada: string;
    try {
      const { path, rawQuery } = rutaYConsulta(request.originalUrl);
      esperada = hmacSha256Hex(
        secreto,
        cadenaFirmaPropietarios({
          timestamp,
          method: request.method,
          path,
          rawQuery,
        }),
      );
    } catch {
      return this.rechazar('no se pudo construir la cadena firmada');
    }

    if (!hmacHexEquals(esperada, coincidencia[1])) {
      return this.rechazar('firma incorrecta');
    }

    return true;
  }

  /** A header counts only if it arrived exactly once, as a plain string. */
  private headerUnico(request: Request, nombre: string): string | null {
    const valor = request.headers[nombre];
    return typeof valor === 'string' && valor.length > 0 ? valor : null;
  }

  private rechazar(motivo: string): never {
    this.logger.warn(`Pull de propietarios rechazado: ${motivo}.`);
    throw new UnauthorizedException();
  }
}

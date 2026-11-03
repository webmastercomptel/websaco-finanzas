// src/modules/integraciones-panel/firma-panel.guard.ts
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
  HEADER_FIRMA,
  HEADER_TIMESTAMP,
  PREFIJO_FIRMA,
  VENTANA_SEGUNDOS,
  cadenaFirma,
} from './firma-panel';

const PATRON_TIMESTAMP = /^\d{1,12}$/;
const PATRON_FIRMA = /^sha256=([0-9a-f]{64})$/;

type PeticionConCuerpoCrudo = Request & { rawBody?: Buffer };

/**
 * Authenticates the integrations panel: an HMAC over timestamp, method, full
 * URL and raw body (see `firma-panel.ts`) with `PANEL_HMAC_SECRET`. First guard
 * of every panel route — the caller is a machine, so there is no Firebase and
 * no tenant, same reasoning as `FirmaWebsaco3Guard`.
 *
 * Fails CLOSED and OPAQUE: an unset/blank secret, a missing or repeated
 * header, a stale timestamp and a wrong signature all throw the same bare
 * `UnauthorizedException`. Only the reason goes to the log — never a header
 * value, the secret, the signature or the URL. Whether the module is switched
 * off is revealed only after this guard passes (`PanelHabilitadoGuard`).
 *
 * The body is signed, so `rawBody: true` must stay on in `main.ts`; without it
 * every request carrying a body would be rejected here.
 */
@Injectable()
export class FirmaPanelGuard implements CanActivate {
  private readonly logger = new Logger(FirmaPanelGuard.name);

  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const secreto = this.config.get<string>('app.panelHmacSecret');
    if (typeof secreto !== 'string' || secreto.trim().length === 0) {
      return this.rechazar('PANEL_HMAC_SECRET no está configurado');
    }

    const request = context.switchToHttp().getRequest<PeticionConCuerpoCrudo>();

    const timestamp = this.headerUnico(request, HEADER_TIMESTAMP);
    const firma = this.headerUnico(request, HEADER_FIRMA);
    if (timestamp === null || firma === null) {
      return this.rechazar('falta un header o está repetido');
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
      return this.rechazar(`firma sin el formato ${PREFIJO_FIRMA}<hex>`);
    }

    const esperada = hmacSha256Hex(
      secreto,
      cadenaFirma({
        timestamp,
        metodo: request.method,
        ruta: request.originalUrl,
        rawBody: request.rawBody ? request.rawBody.toString('utf8') : '',
      }),
    );
    if (!hmacHexEquals(esperada, coincidencia[1])) {
      return this.rechazar('firma incorrecta');
    }

    return true;
  }

  /**
   * A header counts only if it arrived exactly once. Node folds repeated
   * custom headers into one comma-joined value, so `rawHeaders` (the wire view)
   * is what tells a repeat from a single value.
   */
  private headerUnico(request: Request, nombre: string): string | null {
    const valor = request.headers[nombre];
    if (typeof valor !== 'string' || valor.length === 0) return null;

    const repeticiones = (request.rawHeaders ?? []).filter(
      (item, indice) => indice % 2 === 0 && item.toLowerCase() === nombre,
    ).length;
    return repeticiones > 1 ? null : valor;
  }

  private rechazar(motivo: string): never {
    this.logger.warn(`Petición del panel rechazada: ${motivo}.`);
    throw new UnauthorizedException();
  }
}

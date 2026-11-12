// src/modules/factura-publica/cabeceras-de-seguridad.interceptor.ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

/** Sent on EVERY answer of the public invoice route, success or refusal: the
 *  page is a personal document behind a bearer link, never to be cached,
 *  indexed, sniffed or leaked through a `Referer`. */
export const CABECERAS_DE_SEGURIDAD = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
};

/**
 * Sets `CABECERAS_DE_SEGURIDAD` before the handler, and before the global
 * ValidationPipe: Nest runs every interceptor's pre-handler part before the
 * pipes, so a body the pipe rejects (the route's only 400) carries them too,
 * as do the 404 and the 429 the handler throws. Setting them inside the
 * handler missed the 400, which never reaches it.
 *
 * Not covered: an error raised by Express before Nest routes the request (a
 * body that is not valid JSON, a body over the parser's size limit).
 */
@Injectable()
export class CabecerasDeSeguridadInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    context.switchToHttp().getResponse<Response>().set(CABECERAS_DE_SEGURIDAD);
    return next.handle();
  }
}

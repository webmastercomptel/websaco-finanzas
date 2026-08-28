// src/common/interceptors/transform.interceptor.ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { map, type Observable } from 'rxjs';

/** The shape every successful response carries. */
export interface Envelope<T> {
  statusCode: number;
  data: T;
}

/**
 * Wraps every successful response in `{ statusCode, data }`.
 *
 * Applied globally in main.ts, so controllers return their payload plainly and
 * never build this by hand — a handler that assembles its own envelope ends up
 * double-wrapped here.
 *
 * Only successes pass through. Failures are turned into responses by the
 * exception layer and keep Nest's `{ statusCode, message, error }` shape, which
 * is what the browser client reads its error text from. So the envelope is the
 * success shape, not a universal one, and a client must branch on HTTP status
 * before reaching for `data`.
 *
 * The status code is read off the outgoing response rather than assumed to be
 * 200: a `@HttpCode(202)` or the 201 Nest assigns to POST must be reported
 * honestly here, or the body contradicts the header.
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  Envelope<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<Envelope<T>> {
    const response = context.switchToHttp().getResponse<Response>();

    return next
      .handle()
      .pipe(map((data) => ({ statusCode: response.statusCode, data })));
  }
}

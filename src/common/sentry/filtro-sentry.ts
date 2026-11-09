import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

/** Only what is the server's fault: unexpected errors and explicit 5xx. */
export function debeReportarse(exception: unknown): boolean {
  return !(exception instanceof HttpException) || exception.getStatus() >= 500;
}

/**
 * Reports server-side failures to Sentry, then lets Nest's own handling answer
 * exactly as it did before (it extends the default filter and only adds the
 * capture). 4xx are the API doing its job and are never reported.
 */
@Catch()
export class FiltroExcepcionesSentry extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (debeReportarse(exception)) Sentry.captureException(exception);
    super.catch(exception, host);
  }
}

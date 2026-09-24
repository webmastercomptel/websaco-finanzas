// src/modules/publicacion-facturas/publicacion-facturas.controller.ts
import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SecretoProgramadorGuard } from './publicacion-facturas.guard';
import { PublicacionFacturasService } from './publicacion-facturas.service';
import type { ResumenCiclo } from './publicacion-facturas.contrato';

/**
 * The Cloud Scheduler trigger for the retry sweep — see design.md's
 * "Sweep trigger" decision (#4b) for why this is an externally-triggered
 * HTTP endpoint rather than an in-process `@Cron`. Same shape as
 * `HealthController`: a plain `@Controller`, no `FirebaseAuthGuard`, no
 * `PoliciesGuard`, no `@CheckAbility` — this route is machine-to-machine,
 * has no user and no tenant, so CASL and the tenancy law do not apply. Its
 * only guard is its own `SecretoProgramadorGuard`.
 */
@Controller('interno/publicacion-facturas')
@UseGuards(SecretoProgramadorGuard)
export class PublicacionFacturasController {
  constructor(private readonly service: PublicacionFacturasService) {}

  /**
   * Awaits the WHOLE cycle before responding — Cloud Run only guarantees
   * CPU while a request is in flight, so fire-and-forget would recreate the
   * throttling problem `@Cron` had. Always 200 once auth passes: row-level
   * outcomes live in the outbox, not in this response, and a non-2xx would
   * only make Cloud Scheduler retry a sweep that has nothing new to do.
   */
  @Post('procesar-pendientes')
  @HttpCode(200)
  procesarPendientes(): Promise<ResumenCiclo> {
    return this.service.procesarPendientes();
  }
}

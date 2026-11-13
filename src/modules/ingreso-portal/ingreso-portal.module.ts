// src/modules/ingreso-portal/ingreso-portal.module.ts
import { Module } from '@nestjs/common';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { EnlaceIngresoService } from './enlace-ingreso.service';
import { IngresoPortalController } from './ingreso-portal.controller';
import { IngresoPortalService } from './ingreso-portal.service';

/**
 * Resident sign-in by proven address: the two public routes, the sign-in link
 * store and the request/redeem logic.
 *
 * Models come from the @Global DatabaseModule; the Redis limiter, mail, the
 * residency queries, access derivation, Firebase (auth instance and the narrow
 * `FirebaseUsuariosService`) and config from the global modules. The service is
 * exported so the staff resend of Residentes reuses the very same eligibility,
 * counters and e-mail instead of keeping a second copy of their rules.
 *
 * It imports no invoice-link code: the usage of an invoice link is never
 * identity (pinned by a static scan in the store's spec).
 */
@Module({
  imports: [AuditoriaModule],
  controllers: [IngresoPortalController],
  providers: [IngresoPortalService, EnlaceIngresoService],
  exports: [IngresoPortalService],
})
export class IngresoPortalModule {}

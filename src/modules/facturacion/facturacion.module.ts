import { Module } from '@nestjs/common';
import { FacturasService } from './facturas.service';
import { LotesFacturacionService } from './lotes.service';

/**
 * Models come from the @Global DatabaseModule, the guards and
 * TenantContextService from the @Global CommonModule, so there is nothing to
 * import here. Controllers are added by later tasks in this plan.
 */
@Module({
  providers: [FacturasService, LotesFacturacionService],
})
export class FacturacionModule {}

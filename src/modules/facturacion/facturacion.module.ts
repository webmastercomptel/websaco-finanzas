import { Module } from '@nestjs/common';
import { FacturasService } from './facturas.service';

/**
 * Models come from the @Global DatabaseModule, the guards and
 * TenantContextService from the @Global CommonModule, so there is nothing to
 * import here. Controllers and the Lote lifecycle service are added by
 * later tasks in this plan.
 */
@Module({
  providers: [FacturasService],
})
export class FacturacionModule {}

// src/modules/terceros/terceros.module.ts
import { Module } from '@nestjs/common';
import { TercerosController } from './terceros.controller';
import { TercerosService } from './terceros.service';

/**
 * The model comes from the @Global DatabaseModule, the guards and
 * TenantContextService from the @Global CommonModule, so there is nothing to
 * import here.
 */
@Module({
  controllers: [TercerosController],
  providers: [TercerosService],
})
export class TercerosModule {}

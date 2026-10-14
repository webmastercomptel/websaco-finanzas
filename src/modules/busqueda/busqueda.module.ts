// src/modules/busqueda/busqueda.module.ts
import { Module } from '@nestjs/common';
import { BusquedaController } from './busqueda.controller';
import { BusquedaService } from './busqueda.service';

/**
 * Models come from the @Global DatabaseModule and the guards, tenant context
 * and CaslAbilityFactory from the @Global CommonModule / CaslModule, so there
 * is nothing to import here.
 */
@Module({
  controllers: [BusquedaController],
  providers: [BusquedaService],
})
export class BusquedaModule {}

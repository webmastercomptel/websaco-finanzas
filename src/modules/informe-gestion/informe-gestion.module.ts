// src/modules/informe-gestion/informe-gestion.module.ts
import { Module } from '@nestjs/common';
import { InformeGestionController } from './informe-gestion.controller';
import { InformeGestionService } from './informe-gestion.service';

/**
 * Models come from the @Global DatabaseModule; guards, tenant context and
 * CaslAbilityFactory from the @Global CommonModule / CaslModule.
 */
@Module({
  controllers: [InformeGestionController],
  providers: [InformeGestionService],
})
export class InformeGestionModule {}

// src/modules/entidades/entidades.module.ts
import { Module } from '@nestjs/common';
import { EntidadesController } from './entidades.controller';
import { EntidadesService } from './entidades.service';

/**
 * Models come from the @Global DatabaseModule and the guards from the @Global
 * CommonModule, so there is nothing to import here.
 */
@Module({
  controllers: [EntidadesController],
  providers: [EntidadesService],
})
export class EntidadesModule {}

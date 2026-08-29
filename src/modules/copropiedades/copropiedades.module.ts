// src/modules/copropiedades/copropiedades.module.ts
import { Module } from '@nestjs/common';
import { CopropiedadesController } from './copropiedades.controller';
import { CopropiedadesService } from './copropiedades.service';

/**
 * Models come from the @Global DatabaseModule and the guards from the @Global
 * CommonModule, so there is nothing to import here.
 */
@Module({
  controllers: [CopropiedadesController],
  providers: [CopropiedadesService],
})
export class CopropiedadesModule {}

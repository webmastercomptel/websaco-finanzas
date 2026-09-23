// src/modules/plantillas-documento/plantillas-documento.module.ts
import { Module } from '@nestjs/common';
import { PlantillasDocumentoController } from './plantillas-documento.controller';

/**
 * `PlantillaDocumentoService` comes from the @Global `CommonModule`, and the
 * guards from the same place — nothing to provide here beyond the
 * controller. Mirrors `EntidadesModule`'s own shape.
 */
@Module({
  controllers: [PlantillasDocumentoController],
})
export class PlantillasDocumentoModule {}

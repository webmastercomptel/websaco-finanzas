// src/modules/conceptos/conceptos.module.ts
import { Module } from '@nestjs/common';
import { ConceptosController } from './conceptos.controller';
import { ConceptosService } from './conceptos.service';

/**
 * The model comes from the @Global DatabaseModule and the guards from the
 * @Global CommonModule, so there is nothing to import here.
 */
@Module({
  controllers: [ConceptosController],
  providers: [ConceptosService],
})
export class ConceptosModule {}

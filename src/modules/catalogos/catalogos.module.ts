// src/modules/catalogos/catalogos.module.ts
import { Module } from '@nestjs/common';
import { CatalogosController } from './catalogos.controller';
import { CatalogosService } from './catalogos.service';

@Module({
  controllers: [CatalogosController],
  providers: [CatalogosService],
  // Exported so InmueblesModule can resolve DIAN/DANE codes during bulk
  // import, the one other place this static data is read from code instead
  // of an HTTP call.
  exports: [CatalogosService],
})
export class CatalogosModule {}

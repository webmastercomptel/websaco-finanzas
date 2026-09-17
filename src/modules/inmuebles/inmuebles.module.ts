// src/modules/inmuebles/inmuebles.module.ts
import { Module } from '@nestjs/common';
import { InmueblesController } from './inmuebles.controller';
import { InmueblesService } from './inmuebles.service';
import { ValoresRecurrentesService } from './valores-recurrentes.service';
import { InmueblesReporteService } from './inmuebles-reporte.service';
import { InmueblesEliminacionService } from './inmuebles-eliminacion.service';
import { ProgresoImportacionService } from './progreso-importacion.service';
import { CatalogosModule } from '../catalogos/catalogos.module';

/**
 * Models come from the @Global DatabaseModule and the guards from the @Global
 * CommonModule, so there is nothing to import here besides CatalogosModule —
 * bulk import resolves DIAN/DANE codes against it.
 */
@Module({
  imports: [CatalogosModule],
  controllers: [InmueblesController],
  providers: [
    InmueblesService,
    ValoresRecurrentesService,
    InmueblesReporteService,
    InmueblesEliminacionService,
    ProgresoImportacionService,
  ],
})
export class InmueblesModule {}

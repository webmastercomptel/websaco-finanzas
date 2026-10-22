// src/modules/inmuebles/inmuebles.module.ts
import { Module } from '@nestjs/common';
import { InmueblesController } from './inmuebles.controller';
import { InmueblesService } from './inmuebles.service';
import { ValoresRecurrentesService } from './valores-recurrentes.service';
import { InmueblesReporteService } from './inmuebles-reporte.service';
import { InmueblesEliminacionService } from './inmuebles-eliminacion.service';
import { InmueblesSaldosService } from './inmuebles-saldos.service';
import { InmueblesBajaService } from './inmuebles-baja.service';
import { ProgresoImportacionService } from './progreso-importacion.service';
import { CatalogosModule } from '../catalogos/catalogos.module';
import { AuditoriaModule } from '../auditoria/auditoria.module';

/**
 * Models come from the @Global DatabaseModule and the guards from the @Global
 * CommonModule. CatalogosModule is imported because bulk import resolves
 * DIAN/DANE codes against it, and AuditoriaModule because retiring units
 * (`InmueblesBajaService`) leaves an audit entry.
 */
@Module({
  imports: [CatalogosModule, AuditoriaModule],
  controllers: [InmueblesController],
  providers: [
    InmueblesService,
    ValoresRecurrentesService,
    InmueblesReporteService,
    InmueblesEliminacionService,
    InmueblesSaldosService,
    InmueblesBajaService,
    ProgresoImportacionService,
  ],
})
export class InmueblesModule {}

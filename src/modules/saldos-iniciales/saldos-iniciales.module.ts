import { Module } from '@nestjs/common';
import { SaldosInicialesController } from './saldos-iniciales.controller';
import { SaldosInicialesService } from './saldos-iniciales.service';
import { SaldosInicialesAnticipoController } from './saldos-iniciales-anticipo.controller';
import { SaldosInicialesAnticipoService } from './saldos-iniciales-anticipo.service';
import { ProgresoImportacionService } from '../inmuebles/progreso-importacion.service';

@Module({
  controllers: [SaldosInicialesController, SaldosInicialesAnticipoController],
  providers: [
    SaldosInicialesService,
    SaldosInicialesAnticipoService,
    ProgresoImportacionService,
  ],
})
export class SaldosInicialesModule {}

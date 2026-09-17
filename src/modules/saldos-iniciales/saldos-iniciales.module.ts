import { Module } from '@nestjs/common';
import { SaldosInicialesController } from './saldos-iniciales.controller';
import { SaldosInicialesService } from './saldos-iniciales.service';
import { ProgresoImportacionService } from '../inmuebles/progreso-importacion.service';

@Module({
  controllers: [SaldosInicialesController],
  providers: [SaldosInicialesService, ProgresoImportacionService],
})
export class SaldosInicialesModule {}

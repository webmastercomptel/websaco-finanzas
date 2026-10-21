import { Module } from '@nestjs/common';
import { InterfazComptableController } from './interfaz-comptable.controller';
import { InterfazComptableService } from './interfaz-comptable.service';
import { ComptableClientModule } from './comptable-client.module';
import { AdicionContabilidadModule } from '../adicion-contabilidad/adicion-contabilidad.module';
import { FacturacionModule } from '../facturacion/facturacion.module';
import { AuditoriaModule } from '../auditoria/auditoria.module';

/**
 * "Interfaz a Comptable". Models come from the @Global DatabaseModule.
 * AdicionContabilidadModule exports the shared document resolution (the
 * same one the CSV export uses); FacturacionModule the last consolidated
 * period. Nothing in the domain imports this module: deleting it leaves
 * every financial module compiling and correct.
 */
@Module({
  imports: [
    ComptableClientModule,
    AdicionContabilidadModule,
    FacturacionModule,
    AuditoriaModule,
  ],
  controllers: [InterfazComptableController],
  providers: [InterfazComptableService],
})
export class InterfazComptableModule {}

import { Module } from '@nestjs/common';
import { AdicionContabilidadController } from './adicion-contabilidad.controller';
import { AdicionContabilidadService } from './adicion-contabilidad.service';
import { FacturacionModule } from '../facturacion/facturacion.module';
import { AuditoriaModule } from '../auditoria/auditoria.module';

@Module({
  // For LotesFacturacionService.obtenerUltimoConsolidado (the current
  // billing period this export scopes itself to) — FacturacionModule
  // imports nothing itself, so this is a plain one-directional import, no
  // circular require() risk (see FacturacionModule's own comment on that).
  imports: [FacturacionModule, AuditoriaModule],
  controllers: [AdicionContabilidadController],
  providers: [AdicionContabilidadService],
})
export class AdicionContabilidadModule {}

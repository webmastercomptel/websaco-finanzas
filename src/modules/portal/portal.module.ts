// src/modules/portal/portal.module.ts
import { Module } from '@nestjs/common';
import { ConsultasModule } from '../consultas/consultas.module';
import { FacturacionModule } from '../facturacion/facturacion.module';
import { PortalAccesoService } from './portal-acceso.service';
import { PortalController } from './portal.controller';
import { PortalGuard } from './portal.guard';
import { PortalService } from './portal.service';

/** Resident portal. A leaf module: nothing imports it, so it cannot close a cycle. */
@Module({
  imports: [FacturacionModule, ConsultasModule],
  controllers: [PortalController],
  providers: [PortalService, PortalAccesoService, PortalGuard],
})
export class PortalModule {}

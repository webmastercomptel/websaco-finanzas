// src/modules/acceso-residentes/acceso-residentes.module.ts
import { Module } from '@nestjs/common';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { IngresoPortalModule } from '../ingreso-portal/ingreso-portal.module';
import { AccesoResidentesController } from './acceso-residentes.controller';
import { AccesoResidentesService } from './acceso-residentes.service';
import { InvitacionAccesoService } from './invitacion-acceso.service';
import { ResidentesCorreosController } from './residentes-correos.controller';
import { ResidentesCorreosService } from './residentes-correos.service';

/**
 * Models come from the @Global DatabaseModule; guards, the tenant context, mail,
 * access links and `FirebaseUsuariosService` from the @Global CommonModule.
 * `InvitacionAccesoService` is exported so the team module sends the very same
 * invitation instead of keeping a second copy of the email and its rules.
 */
@Module({
  imports: [AuditoriaModule, IngresoPortalModule],
  // The static `residentes/correos` controller is registered first so its
  // literal segment is matched before `residentes/:terceroId/...`.
  controllers: [ResidentesCorreosController, AccesoResidentesController],
  providers: [
    AccesoResidentesService,
    InvitacionAccesoService,
    ResidentesCorreosService,
  ],
  exports: [InvitacionAccesoService],
})
export class AccesoResidentesModule {}

// src/modules/acceso-residentes/acceso-residentes.module.ts
import { Module } from '@nestjs/common';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { AccesoResidentesController } from './acceso-residentes.controller';
import { AccesoResidentesService } from './acceso-residentes.service';
import { InvitacionAccesoService } from './invitacion-acceso.service';

/**
 * Models come from the @Global DatabaseModule; guards, the tenant context, mail,
 * access links and `FirebaseUsuariosService` from the @Global CommonModule.
 * `InvitacionAccesoService` is exported so the team module sends the very same
 * invitation instead of keeping a second copy of the email and its rules.
 */
@Module({
  imports: [AuditoriaModule],
  controllers: [AccesoResidentesController],
  providers: [AccesoResidentesService, InvitacionAccesoService],
  exports: [InvitacionAccesoService],
})
export class AccesoResidentesModule {}

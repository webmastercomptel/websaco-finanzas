// src/modules/equipo/equipo.module.ts
import { Module } from '@nestjs/common';
import { AccesoResidentesModule } from '../acceso-residentes/acceso-residentes.module';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { EquipoController } from './equipo.controller';
import { EquipoService } from './equipo.service';

/**
 * Models come from the @Global DatabaseModule; guards, the tenant context and
 * `FirebaseUsuariosService` from the @Global CommonModule. The invitation email
 * is the one the resident module sends, so it is imported rather than copied.
 */
@Module({
  imports: [AuditoriaModule, AccesoResidentesModule],
  controllers: [EquipoController],
  providers: [EquipoService],
})
export class EquipoModule {}

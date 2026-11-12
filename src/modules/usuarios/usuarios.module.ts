// src/modules/usuarios/usuarios.module.ts
import { Module } from '@nestjs/common';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';
import { AsignacionesUsuarioService } from './asignaciones-usuario.service';
import { AuditoriaModule } from '../auditoria/auditoria.module';

/**
 * Models come from the @Global DatabaseModule, the guards and
 * FirebaseUsuariosService from the @Global CommonModule. AuditoriaModule is
 * imported to inject the audit service into both services: UsuariosService
 * writes the account entries, AsignacionesUsuarioService the per-assignment
 * ones (inside its Mongo transaction).
 */
@Module({
  imports: [AuditoriaModule],
  controllers: [UsuariosController],
  providers: [UsuariosService, AsignacionesUsuarioService],
})
export class UsuariosModule {}

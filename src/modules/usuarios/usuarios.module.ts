// src/modules/usuarios/usuarios.module.ts
import { Module } from '@nestjs/common';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';
import { AuditoriaModule } from '../auditoria/auditoria.module';

/**
 * Models come from the @Global DatabaseModule, the guards and
 * FirebaseUsuariosService from the @Global CommonModule. AuditoriaModule is
 * imported to inject the audit service into UsuariosService, which writes
 * entries after create/update mutations.
 */
@Module({
  imports: [AuditoriaModule],
  controllers: [UsuariosController],
  providers: [UsuariosService],
})
export class UsuariosModule {}

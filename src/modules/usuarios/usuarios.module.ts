// src/modules/usuarios/usuarios.module.ts
import { Module } from '@nestjs/common';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';

/**
 * Models come from the @Global DatabaseModule, the guards and
 * FirebaseUsuariosService from the @Global CommonModule, so there is nothing
 * to import here.
 */
@Module({
  controllers: [UsuariosController],
  providers: [UsuariosService],
})
export class UsuariosModule {}

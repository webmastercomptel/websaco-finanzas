// src/modules/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { EnlaceAccesoController } from './enlace-acceso.controller';

/**
 * Identity endpoints. FirebaseAuthGuard, EnlaceAccesoService and
 * LimiteIntentosService come from the @Global CommonModule, so there is nothing
 * to register here beyond the controllers.
 */
@Module({
  controllers: [AuthController, EnlaceAccesoController],
})
export class AuthModule {}

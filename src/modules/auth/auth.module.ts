// src/modules/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';

/**
 * Identity endpoints. FirebaseAuthGuard is provided by the @Global
 * CommonModule, so there is nothing to register here beyond the controller.
 */
@Module({
  controllers: [AuthController],
})
export class AuthModule {}

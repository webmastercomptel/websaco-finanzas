// src/modules/roles/roles.module.ts
import { Module } from '@nestjs/common';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

/**
 * Models come from the @Global DatabaseModule, guards and tenant context from
 * CommonModule. Role writes are audited, so the audit service is imported.
 */
@Module({
  imports: [AuditoriaModule],
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}

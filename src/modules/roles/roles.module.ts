// src/modules/roles/roles.module.ts
import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';

/** Models come from the @Global DatabaseModule, guards and tenant context from CommonModule. */
@Module({
  controllers: [RolesController],
  providers: [RolesService],
})
export class RolesModule {}

// src/modules/organos/organos.module.ts
import { Module } from '@nestjs/common';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { OrganosController } from './organos.controller';
import { OrganosService } from './organos.service';

/**
 * Models come from the @Global DatabaseModule, guards and tenant context from
 * CommonModule. Member writes are audited. The service is exported because the
 * PQR flow reads the members' addresses through it.
 */
@Module({
  imports: [AuditoriaModule],
  controllers: [OrganosController],
  providers: [OrganosService],
  exports: [OrganosService],
})
export class OrganosModule {}

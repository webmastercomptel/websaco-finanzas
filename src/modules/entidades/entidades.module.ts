// src/modules/entidades/entidades.module.ts
import { Module } from '@nestjs/common';
import { EntidadesController } from './entidades.controller';
import { EntidadesService } from './entidades.service';
import { AuditoriaModule } from '../auditoria/auditoria.module';

/**
 * Models come from the @Global DatabaseModule and the guards from the @Global
 * CommonModule. AuditoriaModule is imported to inject the audit service into
 * EntidadesService, which writes entries after create/update mutations.
 */
@Module({
  imports: [AuditoriaModule],
  controllers: [EntidadesController],
  providers: [EntidadesService],
})
export class EntidadesModule {}

// src/modules/copropiedades/copropiedades.module.ts
import { Module } from '@nestjs/common';
import { CopropiedadesController } from './copropiedades.controller';
import { CopropiedadesService } from './copropiedades.service';
import { AuditoriaModule } from '../auditoria/auditoria.module';

/**
 * Models come from the @Global DatabaseModule and the guards from the @Global
 * CommonModule. AuditoriaModule is imported to inject the audit service into
 * CopropiedadesService, which writes entries after create/update mutations.
 */
@Module({
  imports: [AuditoriaModule],
  controllers: [CopropiedadesController],
  providers: [CopropiedadesService],
})
export class CopropiedadesModule {}

// src/modules/copropiedades/copropiedades.module.ts
import { Module } from '@nestjs/common';
import { CopropiedadesController } from './copropiedades.controller';
import { MiCopropiedadController } from './mi-copropiedad.controller';
import { CopropiedadesService } from './copropiedades.service';
import { AuditoriaModule } from '../auditoria/auditoria.module';
import { ConceptosModule } from '../conceptos/conceptos.module';
import { ComptableClientModule } from '../interfaz-comptable/comptable-client.module';

/**
 * Models come from the @Global DatabaseModule and the guards from the @Global
 * CommonModule. AuditoriaModule is imported to inject the audit service into
 * CopropiedadesService, which writes entries after create/update mutations.
 * ConceptosModule is imported to auto-create default billing concepts on
 * coproperty creation.
 */
@Module({
  // ComptableClientModule: the signed GET that confirms a `comptableEmpresaId`
  // exists in Comptable before it is saved.
  imports: [AuditoriaModule, ConceptosModule, ComptableClientModule],
  controllers: [CopropiedadesController, MiCopropiedadController],
  providers: [CopropiedadesService],
})
export class CopropiedadesModule {}

// src/modules/auditoria/auditoria.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  RegistroAuditoria,
  RegistroAuditoriaSchema,
} from '../../database/schemas/auditoria/registro-auditoria.schema';
import { AuditoriaService } from './auditoria.service';
import { AuditoriaController } from './auditoria.controller';

/**
 * Owns the audit trail for platform-level mutations. The service is exported
 * so that EntidadesModule, CopropiedadesModule, and UsuariosModule can each
 * inject it and write entries after their own mutations succeed.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RegistroAuditoria.name, schema: RegistroAuditoriaSchema },
    ]),
  ],
  controllers: [AuditoriaController],
  providers: [AuditoriaService],
  exports: [AuditoriaService],
})
export class AuditoriaModule {}

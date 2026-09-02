// src/modules/panel-control/panel-control.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  EntidadAdministradora,
  EntidadAdministradoraSchema,
} from '../../database/schemas/entidades/entidad-administradora.schema';
import {
  Copropiedad,
  CopropiedadSchema,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Account,
  AccountSchema,
} from '../../database/schemas/cuentas/account.schema';
import { PanelControlService } from './panel-control.service';
import { PanelControlController } from './panel-control.controller';

/**
 * Dashboard for the platform operator. Imports only the three models it needs
 * to count — not the full Entidades/Copropiedades/Usuarios modules, which
 * would drag in their controllers and services for no reason.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: EntidadAdministradora.name, schema: EntidadAdministradoraSchema },
      { name: Copropiedad.name, schema: CopropiedadSchema },
      { name: Account.name, schema: AccountSchema },
    ]),
  ],
  controllers: [PanelControlController],
  providers: [PanelControlService],
})
export class PanelControlModule {}

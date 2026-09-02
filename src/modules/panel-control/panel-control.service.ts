// src/modules/panel-control/panel-control.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  EntidadAdministradora,
  EntidadAdministradoraDocument,
} from '../../database/schemas/entidades/entidad-administradora.schema';
import {
  Copropiedad,
  CopropiedadDocument,
} from '../../database/schemas/copropiedades/copropiedad.schema';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import type { ResumenPanelControl } from '../../contracts';

/**
 * Provides the dashboard KPIs for the super-admin panel.
 *
 * Three simple countDocuments calls — no aggregation, matching the house
 * convention for straightforward counts.
 */
@Injectable()
export class PanelControlService {
  constructor(
    @InjectModel(EntidadAdministradora.name)
    private readonly entidades: Model<EntidadAdministradoraDocument>,
    @InjectModel(Copropiedad.name)
    private readonly copropiedades: Model<CopropiedadDocument>,
    @InjectModel(Account.name)
    private readonly accounts: Model<AccountDocument>,
  ) {}

  async resumen(): Promise<ResumenPanelControl> {
    const [totalEntidades, totalCopropiedadesActivas, totalUsuariosActivos] =
      await Promise.all([
        this.entidades.countDocuments({}).exec(),
        this.copropiedades.countDocuments({ status: 'active' }).exec(),
        this.accounts.countDocuments({ status: 'active' }).exec(),
      ]);

    return { totalEntidades, totalCopropiedadesActivas, totalUsuariosActivos };
  }
}

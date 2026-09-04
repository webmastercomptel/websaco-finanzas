// src/modules/copropiedades/mi-copropiedad.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { CopropiedadesService } from './copropiedades.service';
import type { Copropiedad } from '../../contracts';

/**
 * Read-only view of the active coproperty's own catalog record ("Datos" in
 * "Mi copropiedad") for a customer administrator — tenant-scoped via
 * `TenantContextService`, unlike `CopropiedadesController`'s `:id`-scoped
 * `PlatformAdminGuard` routes, which stay the only way to edit this record.
 *
 * There is deliberately no PATCH here yet: which fields (if any) a coproperty
 * admin may change on their own building's identity record — nombre/NIT vs.
 * `entidadAdministradoraId`/`estado`/the accounting-integration accounts — is
 * a product decision still pending, not a technical one. Reuses
 * `CopropiedadesService.findOne`, the same method `CopropiedadesController`
 * calls, rather than duplicating the query.
 */
@Controller('mi-copropiedad')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class MiCopropiedadController {
  constructor(
    private readonly copropiedades: CopropiedadesService,
    private readonly tenant: TenantContextService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  findOne(): Promise<Copropiedad> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.copropiedades.findOne(coPropertyId.toString());
  }
}

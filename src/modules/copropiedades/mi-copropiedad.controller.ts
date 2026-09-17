// src/modules/copropiedades/mi-copropiedad.controller.ts
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { CopropiedadesService } from './copropiedades.service';
import { CopiarConfiguracionDto } from './dto/copiar-configuracion.dto';
import type { Copropiedad, CopropiedadResumen } from '../../contracts';

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

  /**
   * Other active coproperties under the active coproperty's own entidad
   * administradora — what the "copiar configuración" picker offers. Empty
   * when the active coproperty has no managing entity on file.
   */
  @Get('hermanas')
  @CheckAbility({ action: 'read', subject: 'Configuracion' })
  listarHermanas(): Promise<CopropiedadResumen[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.copropiedades.listarHermanas(coPropertyId);
  }

  /**
   * Fills the active coproperty's maestro de cuentas, cargos and parámetros
   * de facturación from `dto.origenId` — same action and same guardrails as
   * `CopropiedadesController.copiarConfiguracion` (additive only, same
   * entidad administradora required), just scoped to the caller's OWN
   * coproperty instead of an arbitrary `:id`, and gated by the ordinary
   * `Configuracion` permission a coproperty admin already holds to edit
   * their own cuentas/cargos/parámetros by hand — not `PlatformAdminGuard`.
   */
  @Post('copiar-configuracion')
  @CheckAbility({ action: 'update', subject: 'Configuracion' })
  copiarConfiguracion(
    @Body() dto: CopiarConfiguracionDto,
    @CurrentUser() user: IRequestUser,
  ): Promise<Copropiedad> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.copropiedades.copiarConfiguracion(
      coPropertyId.toString(),
      dto,
      { accountId: user.accountId!, nombre: user.nombre ?? user.email },
    );
  }
}

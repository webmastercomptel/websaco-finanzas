// src/modules/conceptos/conceptos.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import { PoliciesGuard } from '../casl/policies.guard';
import { CheckAbility } from '../casl/check-ability.decorator';
import { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ConceptosService } from './conceptos.service';
import {
  ActualizarConceptoDto,
  CrearConceptoDto,
} from './dto/guardar-concepto.dto';
import type { ConceptoCobro } from '../../contracts';

/**
 * The billing concepts ("Cargos") the active coproperty can charge —
 * `ConceptoCobro` is its own CASL subject, distinct from `Configuracion`,
 * because a concept feeds financial documents directly (see the note on
 * `SUBJECTS` in casl-ability.constants.ts).
 *
 * Was `PlatformAdminGuard` on a `copropiedades/:copropiedadId/conceptos`
 * route until a coproperty's own administrator got a screen for this
 * ("Mi copropiedad" → Cargos); now tenant-scoped like every other
 * `Configuracion`-adjacent controller, resolved from `TenantContextService`
 * rather than a client-supplied id. Still reachable by the platform
 * administrator editing an arbitrary building: `AccesoService` grants a
 * platform admin the `X-CoProperty-Id` of any coproperty, and their ability
 * is `manage all` regardless of subject.
 *
 * DELETE exists, unlike most of this domain — see the guards in
 * ConceptosService.delete() for why a concept is the one thing here that
 * can be gone for good rather than just retired. Gated by `manage` (the
 * `conceptos.gestionar` permission key), stricter than the `update` that
 * editing a concept only needs.
 */
@Controller('conceptos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
export class ConceptosController {
  constructor(
    private readonly conceptos: ConceptosService,
    private readonly tenant: TenantContextService,
  ) {}

  @Get()
  @CheckAbility({ action: 'read', subject: 'ConceptoCobro' })
  findAll(): Promise<ConceptoCobro[]> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.conceptos.findAll(coPropertyId.toString());
  }

  @Post()
  @CheckAbility({ action: 'create', subject: 'ConceptoCobro' })
  create(@Body() dto: CrearConceptoDto): Promise<ConceptoCobro> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.conceptos.create(coPropertyId.toString(), dto);
  }

  @Patch(':id')
  @CheckAbility({ action: 'update', subject: 'ConceptoCobro' })
  update(
    @Param('id') id: string,
    @Body() dto: ActualizarConceptoDto,
  ): Promise<ConceptoCobro> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.conceptos.update(coPropertyId.toString(), id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @CheckAbility({ action: 'manage', subject: 'ConceptoCobro' })
  delete(@Param('id') id: string): Promise<void> {
    const coPropertyId = this.tenant.resolveCoPropertyId();
    return this.conceptos.delete(coPropertyId.toString(), id);
  }
}

// src/modules/catalogo-permisos/catalogo-permisos.controller.ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import { FirebaseAuthGuard } from '../../common/guards/firebase-auth.guard';
import type { PermisosFinanzas } from '../../contracts';
import { CheckAnyAbility, ModuloAlguno } from '../casl/check-ability.decorator';
import { PERMISOS_FINANZAS } from '../casl/permisos-catalogo';
import { PoliciesGuard } from '../casl/policies.guard';

/**
 * The permission vocabulary the team screens (`/equipo`, `/roles`) draw, for
 * callers that are NOT platform admins: `GET /usuarios/permisos-finanzas` is
 * the same list but sits behind `PlatformAdminGuard`, which a building's own
 * administrator can never pass.
 *
 * Static vocabulary: no service, no query, no tenant data (the answer is the
 * same for every coproperty), so there is nothing here to scope. It sits under
 * `PoliciesGuard` anyway, for the licence and for who may see it.
 *
 * - Licence: either module (`@ModuloAlguno`), like the screens that use it: a
 *   Finanzas-only building manages its team too.
 * - Ability: ANY of read/create/update `Usuario` or read `Rol`, i.e. whoever can
 *   open Equipo or Roles. It is the catalog, not a delegation: what a caller may
 *   actually give is judged on the write, by exact key.
 */
@Controller('catalogo-permisos')
@UseGuards(FirebaseAuthGuard, PoliciesGuard)
@ModuloAlguno('finanzas', 'administracion')
export class CatalogoPermisosController {
  /** The Finanzas keys that exist for real (56), a fresh array per call. */
  @Get('finanzas')
  @CheckAnyAbility(
    { action: 'read', subject: 'Usuario' },
    { action: 'create', subject: 'Usuario' },
    { action: 'update', subject: 'Usuario' },
    { action: 'read', subject: 'Rol' },
  )
  finanzas(): PermisosFinanzas {
    return { claves: [...PERMISOS_FINANZAS] };
  }
}

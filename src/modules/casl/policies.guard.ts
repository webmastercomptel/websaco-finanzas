// src/modules/casl/policies.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CaslAbilityFactory } from './casl-ability.factory';
import {
  AUTHENTICATED_ONLY_KEY,
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
} from './check-ability.decorator';
import type { RequiredRule } from './check-ability.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { exigirModulo } from '../../common/licencia/exigir-modulo';

interface AuthenticatedRequest extends Request {
  user?: IRequestUser;
}

/**
 * Enforces the abilities declared with the CheckAbility (all required) and
 * CheckAnyAbility (at least one required) decorators.
 *
 * Runs AFTER the auth guard, since it reads `request.user` — which is why it is
 * applied per controller in the same UseGuards list, never as a global
 * APP_GUARD where that ordering would not hold.
 *
 * Default-deny: a route under this guard with neither ability rules nor an
 * explicit `AuthenticatedOnly()` is refused. With no authenticated caller it
 * also denies, so a decorated route fails closed instead of silently running
 * unauthenticated.
 */
@Injectable()
export class PoliciesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly abilityFactory: CaslAbilityFactory,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const rules = this.reflector.getAllAndOverride<RequiredRule[]>(
      CHECK_ABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const anyRules = this.reflector.getAllAndOverride<RequiredRule[]>(
      CHECK_ANY_ABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const hasAll = !!rules && rules.length > 0;
    const hasAny = !!anyRules && anyRules.length > 0;
    const authenticatedOnly =
      this.reflector.getAllAndOverride<boolean | undefined>(
        AUTHENTICATED_ONLY_KEY,
        [context.getHandler(), context.getClass()],
      ) === true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('No tenés permiso para esta acción');
    }

    // Licence: a route that belongs to a product module needs the active
    // coproperty to have contracted it, whatever permissions the caller holds
    // (platform administrators included: the licence is about the coproperty).
    const modulo = this.reflector.getAllAndOverride<string | undefined>(
      MODULO_KEY,
      [context.getHandler(), context.getClass()],
    );
    exigirModulo(modulo, user);

    // Default-deny: a route under this guard must declare what it needs. No
    // rules and no explicit `@AuthenticatedOnly()` means the route was forgotten,
    // and a forgotten route must fail closed, never open.
    if (!hasAll && !hasAny) {
      if (authenticatedOnly) return true;
      throw new ForbiddenException('No tenés permiso para esta acción');
    }

    const ability = this.abilityFactory.createForUser(user);
    // CheckAbility: every rule (AND). CheckAnyAbility: at least one (OR).
    // Both present: both conditions must hold.
    const allowed =
      (!hasAll || rules.every((r) => ability.can(r.action, r.subject))) &&
      (!hasAny || anyRules.some((r) => ability.can(r.action, r.subject)));
    if (!allowed) {
      throw new ForbiddenException('No tenés permiso para esta acción');
    }
    return true;
  }
}

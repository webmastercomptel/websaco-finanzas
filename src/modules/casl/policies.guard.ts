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
import { CHECK_ABILITY_KEY } from './check-ability.decorator';
import type { RequiredRule } from './check-ability.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

interface AuthenticatedRequest extends Request {
  user?: IRequestUser;
}

/**
 * Enforces the abilities declared with the CheckAbility decorator.
 *
 * Runs AFTER the auth guard, since it reads `request.user` — which is why it is
 * applied per controller in the same UseGuards list, never as a global
 * APP_GUARD where that ordering would not hold.
 *
 * With no authenticated caller it denies. That is what makes it safe to wire in
 * before the auth guard exists: a decorated route fails closed instead of
 * silently running unauthenticated.
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
    // Opt-in: routes without the decorator are not gated here.
    if (!rules || rules.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('No tenés permiso para esta acción');
    }

    const ability = this.abilityFactory.createForUser(user);
    const allowed = rules.every((r) => ability.can(r.action, r.subject));
    if (!allowed) {
      throw new ForbiddenException('No tenés permiso para esta acción');
    }
    return true;
  }
}

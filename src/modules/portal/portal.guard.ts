// src/modules/portal/portal.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { exigirModulo } from '../../common/licencia/exigir-modulo';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { MODULO_KEY } from '../casl/check-ability.decorator';

interface AuthenticatedRequest extends Request {
  user?: IRequestUser;
}

/**
 * Gate for the resident portal (`/portal/*`): the caller must CURRENTLY hold an
 * active unit (as owner or tenant) of the ACTIVE coproperty — `esResidente`,
 * derived per request by `AccesoService` from `Tercero.accountId` plus the
 * unit's `titularId`/`arrendatarioId`, so a former owner or tenant whose Tercero
 * is still linked is refused — and that coproperty must have contracted the
 * route's module. It checks the door only; WHICH units and
 * documents a resident may see is decided per request by `PortalService`, from
 * the units they actually hold.
 *
 * Runs after `FirebaseAuthGuard` (it reads `request.user`), like
 * `PoliciesGuard`, and is the resident-side counterpart of it: residents carry
 * no CASL permissions, so they never reach an administrative route.
 */
@Injectable()
export class PortalGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user?.esResidente || !user.copropiedadId || !user.accountId) {
      throw new ForbiddenException(
        'No tenés acceso al portal de esta copropiedad',
      );
    }
    exigirModulo(
      this.reflector.getAllAndOverride<string | undefined>(MODULO_KEY, [
        context.getHandler(),
        context.getClass(),
      ]),
      user,
    );
    return true;
  }
}

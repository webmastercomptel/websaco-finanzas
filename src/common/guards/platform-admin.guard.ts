// src/common/guards/platform-admin.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { IRequestUser } from '../interfaces/request-user.interface';

interface AuthenticatedRequest extends Request {
  user?: IRequestUser;
}

/**
 * Restricts a route to the platform operator.
 *
 * Managing entities and coproperties are not tenant data — they are what
 * DEFINES a tenant. There is no active coproperty to scope them by, and no
 * per-building CASL permission a customer's administrator could hold for
 * them, because these records exist above any single building. This mirrors
 * the "Instalación" panel in the system this replaces, which only opened for
 * a rol 4 / "Administrador Comptel" account.
 *
 * Runs after FirebaseAuthGuard, which is what populates `request.user`. It is
 * a separate guard rather than a CASL subject on purpose: routing this
 * through PoliciesGuard would suggest a customer's administrator could be
 * granted the permission, and none ever should be.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user?.isPlatformAdmin) {
      throw new ForbiddenException(
        'Esta acción requiere ser administrador de la plataforma',
      );
    }
    return true;
  }
}

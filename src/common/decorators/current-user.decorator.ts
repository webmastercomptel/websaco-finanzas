// src/common/decorators/current-user.decorator.ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { IRequestUser } from '../interfaces/request-user.interface';

interface AuthenticatedRequest extends Request {
  user?: IRequestUser;
}

/**
 * Injects the authenticated caller into a handler parameter.
 *
 * Only meaningful on a route behind FirebaseAuthGuard — without it there is no
 * `request.user` and this yields undefined. The declared type says otherwise,
 * so never reach for this decorator on an unguarded route.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): IRequestUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user as IRequestUser;
  },
);

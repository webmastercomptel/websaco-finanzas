// src/common/licencia/exigir-modulo.ts
import { ForbiddenException } from '@nestjs/common';
import type { IRequestUser } from '../interfaces/request-user.interface';

/**
 * Refuses the request unless the active coproperty has contracted `modulo`.
 * A route that declares no module is not gated here (the route-policy
 * inventory test forces every route to declare one). Shared by every guard that
 * serves module routes, so the licence rule lives in exactly one place.
 */
export function exigirModulo(
  modulo: string | undefined,
  user: Pick<IRequestUser, 'modulos'>,
): void {
  if (modulo && !(user.modulos as string[] | undefined)?.includes(modulo)) {
    throw new ForbiddenException(
      'Tu copropiedad no tiene contratado este módulo',
    );
  }
}

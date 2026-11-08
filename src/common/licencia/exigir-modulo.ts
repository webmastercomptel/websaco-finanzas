// src/common/licencia/exigir-modulo.ts
import { ForbiddenException } from '@nestjs/common';
import type { IRequestUser } from '../interfaces/request-user.interface';

/**
 * Refuses the request unless the active coproperty has contracted `modulo`.
 * A list means "any of these": the route is shared by several products and one
 * contracted module is enough (an empty list matches nothing, so it fails
 * closed). A route that declares no module is not gated here (the route-policy
 * inventory test forces every route to declare one). Shared by every guard that
 * serves module routes, so the licence rule lives in exactly one place.
 */
export function exigirModulo(
  modulo: string | readonly string[] | undefined,
  user: Pick<IRequestUser, 'modulos'>,
): void {
  if (!modulo) return;
  const requeridos = typeof modulo === 'string' ? [modulo] : modulo;
  const contratados = (user.modulos as string[] | undefined) ?? [];
  if (!requeridos.some((m) => contratados.includes(m))) {
    throw new ForbiddenException(
      'Tu copropiedad no tiene contratado este módulo',
    );
  }
}

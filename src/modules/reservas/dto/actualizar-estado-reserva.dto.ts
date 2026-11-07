// src/modules/reservas/dto/actualizar-estado-reserva.dto.ts
import { IsIn } from 'class-validator';

/** States staff may move a booking to. `pendiente` is only ever the initial one. */
export const ESTADOS_RESERVA_ASIGNABLES = [
  'aprobada',
  'rechazada',
  'cancelada',
] as const;
export type EstadoReservaAsignable =
  (typeof ESTADOS_RESERVA_ASIGNABLES)[number];

/** Body of `PATCH /reservas/:id/estado`. */
export class ActualizarEstadoReservaDto {
  @IsIn(ESTADOS_RESERVA_ASIGNABLES)
  estado: EstadoReservaAsignable;
}

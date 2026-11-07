// src/modules/reservas/dto/listar-disponibilidad.dto.ts
import { IsISO8601, IsNotEmpty } from 'class-validator';

/**
 * Query of both availability routes. `fecha` is required and validated: the
 * system this replaces fed whatever arrived to `new Date()` and let an invalid
 * one blow up as a 500.
 */
export class ListarDisponibilidadDto {
  @IsISO8601()
  @IsNotEmpty()
  fecha: string;
}

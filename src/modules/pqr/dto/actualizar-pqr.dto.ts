import { IsIn, IsMongoId, IsOptional, ValidateIf } from 'class-validator';
import {
  ESTADOS_PQR_ASIGNABLES,
  PRIORIDADES_PQR_ENTRADA,
  type EstadoPqr,
} from '../../../database/schemas/administracion/pqr.schema';

/**
 * Body of `PATCH /pqrs/:id`: status, priority and assigned technician. Every
 * field is optional; only the ones present are written. `tecnicoId: null`
 * unassigns. `cerrado` is not accepted: only the nightly sweep closes a PQR.
 */
export class ActualizarPqrDto {
  @IsIn(ESTADOS_PQR_ASIGNABLES)
  @IsOptional()
  estado?: Exclude<EstadoPqr, 'cerrado'>;

  /** `urgente` is a legacy alias normalized to `alta`. */
  @IsIn(PRIORIDADES_PQR_ENTRADA)
  @IsOptional()
  prioridad?: (typeof PRIORIDADES_PQR_ENTRADA)[number];

  @ValidateIf((_, value) => value !== null)
  @IsMongoId()
  @IsOptional()
  tecnicoId?: string | null;
}

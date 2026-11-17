import { IsIn, IsMongoId, IsOptional, ValidateIf } from 'class-validator';
import {
  ESTADOS_PQR,
  ESTADOS_PQR_LEGADOS,
  PRIORIDADES_PQR_ENTRADA,
} from '../../../database/schemas/administracion/pqr.schema';

/**
 * Body of `PATCH /pqrs/:id`: stage, priority and assigned technician. Every
 * field is optional; only the ones present are written. `tecnicoId: null`
 * unassigns. The accepted stage values are the four stages plus the legacy
 * ones (an open old tab may still send them); what each does is decided by the
 * service.
 */
export class ActualizarPqrDto {
  @IsIn([...ESTADOS_PQR, ...ESTADOS_PQR_LEGADOS])
  @IsOptional()
  estado?: (typeof ESTADOS_PQR)[number] | (typeof ESTADOS_PQR_LEGADOS)[number];

  /** `urgente` is a legacy alias normalized to `alta`. */
  @IsIn(PRIORIDADES_PQR_ENTRADA)
  @IsOptional()
  prioridad?: (typeof PRIORIDADES_PQR_ENTRADA)[number];

  @ValidateIf((_, value) => value !== null)
  @IsMongoId()
  @IsOptional()
  tecnicoId?: string | null;
}

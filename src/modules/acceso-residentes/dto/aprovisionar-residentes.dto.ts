// src/modules/acceso-residentes/dto/aprovisionar-residentes.dto.ts
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** Largest page one request may process: each party costs a Firebase call and an email. */
export const MAX_APROVISIONAMIENTO = 25;

/**
 * Body of `POST /residentes/aprovisionar`: one page of a resumable run. The
 * screen repeats the call, passing back `siguienteDesde`, until `pendientes` is 0.
 */
export class AprovisionarResidentesDto {
  /** Cursor: only parties whose id is greater than this are examined. */
  @IsOptional()
  @Matches(/^[0-9a-f]{24}$/i, { message: 'desde debe ser un id válido' })
  desde?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_APROVISIONAMIENTO)
  limite?: number;
}

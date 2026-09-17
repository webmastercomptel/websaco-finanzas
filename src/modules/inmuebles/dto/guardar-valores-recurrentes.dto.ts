// src/modules/inmuebles/dto/guardar-valores-recurrentes.dto.ts
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsNumber,
  Min,
  ValidateNested,
} from 'class-validator';

export class ValorRecurrenteLineaDto {
  @IsMongoId()
  conceptoId: string;

  /** `0` deletes the ValorRecurrente row for this pair — see the note on the
   *  `ValorRecurrente` contract type: zero means "not charged", not "charged
   *  zero". */
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto: number;
}

/** Replaces a unit's whole set of recurring amounts in one call — the
 *  frontend always sends back every concept it got from GET, not a partial
 *  patch, so there is no ambiguity about which pairs are meant to be
 *  cleared. */
export class GuardarValoresRecurrentesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ValorRecurrenteLineaDto)
  valores: ValorRecurrenteLineaDto[];
}

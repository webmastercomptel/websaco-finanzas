// src/modules/inmuebles/dto/importar-valores-recurrentes.dto.ts
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ValorRecurrenteLineaDto } from './guardar-valores-recurrentes.dto';

/**
 * One row of a bulk valores-recurrentes load: an EXISTING unit's code plus
 * whatever cargo amounts the file carried for it. Never creates or deletes an
 * inmueble — a code with no match in this coproperty fails only that row
 * (see `ValoresRecurrentesService.importarMasivo`), the same "rows are
 * independent" convention `InmueblesService.importar` uses for the full
 * roster import. Unlike that import, this one never touches the unit roster
 * itself, only `ValorRecurrente` rows — see the controller's own note on why
 * this is a separate endpoint.
 */
export class FilaValorRecurrenteMasivoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ValorRecurrenteLineaDto)
  valores: ValorRecurrenteLineaDto[];
}

/**
 * The file is parsed into rows on the frontend, same convention as
 * `ImportarInmueblesDto` — this endpoint only ever sees plain JSON.
 */
export class ImportarValoresRecurrentesMasivoDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FilaValorRecurrenteMasivoDto)
  filas: FilaValorRecurrenteMasivoDto[];
}

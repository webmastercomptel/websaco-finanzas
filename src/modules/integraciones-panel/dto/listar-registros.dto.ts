// src/modules/integraciones-panel/dto/listar-registros.dto.ts
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  NotContains,
} from 'class-validator';
import { ID_REGISTRO_REGEX } from '../id-registro';

/** Query of `GET integraciones/panel/registros`. Any other parameter is a 400. */
export class ListarRegistrosDto {
  /** Free text over name, NIT and code; escaped, never a regex. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  // A NUL byte inside a `$regex` makes Mongo fail with a 500 instead of a 400.
  @NotContains('\u0000')
  q?: string;

  /** Returns at most that one record. */
  @IsOptional()
  @Matches(ID_REGISTRO_REGEX)
  id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100000)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limite?: number;
}

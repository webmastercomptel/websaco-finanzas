import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsPositive,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One row of the uploaded file, already parsed to JSON by the frontend
 *  (this module never parses the .xlsx itself — same division of labor as
 *  `LotesFacturacionService.cargarNovedades()`). */
export class FilaLoteRecibosDto {
  @IsString()
  @MinLength(1)
  inmuebleCodigo: string;

  @IsDateString()
  fechaPago: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  valorRecibido: number;
}

export class CargarFilasLoteRecibosDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FilaLoteRecibosDto)
  filas: FilaLoteRecibosDto[];
}

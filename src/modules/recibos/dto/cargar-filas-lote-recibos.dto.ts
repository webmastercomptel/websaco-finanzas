import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One row of the uploaded file, already parsed to JSON by the frontend
 *  (this module never parses the .xlsx itself — same division of labor as
 *  `LotesFacturacionService.cargarNovedades()`). `copropiedadCodigo` is
 *  optional: a file without that column simply skips the cross-check. */
export class FilaLoteRecibosDto {
  @IsString()
  @MinLength(1)
  inmuebleCodigo: string;

  @IsOptional()
  @IsString()
  copropiedadCodigo?: string;

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

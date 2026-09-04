// src/modules/configuracion/cuentas-contables/dto/importar-cuentas.dto.ts
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One row of a bulk import: the same fields `CrearCuentaDto` accepts,
 *  named for a spreadsheet column instead of a form field. */
export class FilaImportarCuentaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre: string;

  @IsOptional()
  @IsBoolean()
  requiereTercero?: boolean;

  @IsOptional()
  @IsBoolean()
  flujoCaja?: boolean;

  @IsOptional()
  @IsBoolean()
  centroUtilidad?: boolean;

  @IsOptional()
  @IsBoolean()
  centroDestino?: boolean;

  @IsOptional()
  @IsBoolean()
  requiereDocumentoCruce?: boolean;

  @IsOptional()
  @IsBoolean()
  aplicaImpuesto?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  tasaImpuesto?: number;
}

/**
 * The file is parsed into rows on the frontend, same as
 * `ImportarInmueblesDto` — this endpoint only ever sees plain JSON.
 */
export class ImportarCuentasDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FilaImportarCuentaDto)
  filas: FilaImportarCuentaDto[];
}

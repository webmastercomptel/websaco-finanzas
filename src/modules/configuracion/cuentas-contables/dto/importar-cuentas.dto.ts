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
  /** The active coproperty's own `Copropiedad.code` — a row-level safety
   *  check on top of the tenancy law (never what resolves the tenant), same
   *  convention `FilaSaldoInicialDto` uses, so a file meant for a different
   *  building fails loudly per row instead of silently loading its chart of
   *  accounts into this one — see `CuentasContablesService.importar`. */
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigoCopropiedad: string;

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
  esBanco?: boolean;

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

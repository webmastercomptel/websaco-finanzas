// src/modules/conceptos/dto/guardar-concepto.dto.ts
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Everything about a billing concept except its name, all optional.
 *
 * Split the same way as CrearInmuebleDto/ActualizarInmuebleDto: creating
 * requires a name, editing does not, and a subclass cannot relax a parent's
 * required field into an optional one.
 *
 * `copropiedadId` is absent from all of this by design: it comes from the
 * route, never the body — accepting it here would let a caller write into
 * another building's concepts.
 */
class CamposConceptoDto {
  @IsOptional()
  @IsIn(['administracion', 'intereses', 'otro'])
  tipo?: 'administracion' | 'intereses' | 'otro';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  tasaImpuesto?: number;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  cuentaDebitoId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  cuentaCreditoId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(24)
  cuentaImpuestoId?: string;

  @IsOptional()
  @IsBoolean()
  liquidaMora?: boolean;

  @IsOptional()
  @IsBoolean()
  cargaXls?: boolean;

  @IsOptional()
  @IsBoolean()
  sistema?: boolean;
}

/** Creating a concept. The name is the one thing it cannot be created without. */
export class CrearConceptoDto extends CamposConceptoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre: string;
}

/**
 * Editing a concept. All fields optional — the caller only sends what changes.
 */
export class ActualizarConceptoDto extends CamposConceptoDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre?: string;
}

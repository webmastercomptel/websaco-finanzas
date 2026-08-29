// src/modules/conceptos/dto/guardar-concepto.dto.ts
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
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
  @Type(() => Number)
  @IsInt()
  orden?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  cuentaContableIngreso?: string;
}

/** Creating a concept. The name is the one thing it cannot be created without. */
export class CrearConceptoDto extends CamposConceptoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre: string;
}

/**
 * Editing a concept. `activo` is here, and it is how one is retired:
 * `false` stops it being charged going forward without touching a single
 * document that already references it. There is no delete.
 */
export class ActualizarConceptoDto extends CamposConceptoDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}

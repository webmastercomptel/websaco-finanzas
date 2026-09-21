// src/modules/inmuebles/dto/guardar-inmueble.dto.ts
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Everything about a unit except its code, all optional.
 *
 * The two operations inherit from this rather than one from the other: creating
 * requires a code, editing does not, and a subclass cannot relax a parent's
 * required field into an optional one. Sharing the optional part and adding the
 * difference is the shape that actually types.
 *
 * `coPropertyId` is absent from all of this by design and must never be added:
 * the building comes from the request context, and accepting it in the body
 * would let a caller write into somebody else's property.
 */
class CamposInmuebleDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  referencia?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  bloque?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  zona?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  uso?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  area?: number;

  /**
   * Share of the building, as a percentage. Capped at 100 because a single unit
   * cannot exceed the whole property — a typo of 1845 for 18.45 would otherwise
   * distort every proportional split silently.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  coeficiente?: number;

  /** The party responsible for the charges. */
  @IsOptional()
  @IsMongoId()
  titularId?: string;

  @IsOptional()
  @IsIn(['propietario', 'arrendatario'])
  tipoTitular?: 'propietario' | 'arrendatario';

  @IsOptional()
  @IsBoolean()
  resideEnElInmueble?: boolean;

  @IsOptional()
  @IsIn(['vigente', 'juridico', 'dificil_recaudo'])
  estadoCartera?: 'vigente' | 'juridico' | 'dificil_recaudo';

  /** Whether the unit is billed going forward — see the contract's own
   *  note on `Inmueble.estado`. Defaults to `activo` (the schema's own
   *  default), so omitting it on create is the common case. */
  @IsOptional()
  @IsIn(['activo', 'inactivo'])
  estado?: 'activo' | 'inactivo';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contacto?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observaciones?: string;
}

/** Creating a unit. The code is the one thing it cannot be created without. */
export class CrearInmuebleDto extends CamposInmuebleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo: string;
}

/**
 * Editing a unit. Every field optional — a patch that had to carry the whole
 * record would make two people editing different fields overwrite each other.
 *
 * `estado` toggles whether the unit is billed going forward (product
 * decision, 2026-09-21) — a soft retire, distinct from
 * `InmueblesEliminacionService`'s hard delete (only for a unit that has
 * never been billed at all). Marking `inactivo` never touches a single past
 * Factura/Recibo/etc.
 */
export class ActualizarInmuebleDto extends CamposInmuebleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo?: string;
}

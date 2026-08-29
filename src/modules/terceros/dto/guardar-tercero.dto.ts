// src/modules/terceros/dto/guardar-tercero.dto.ts
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Everything about a party except its person type and name, all optional.
 *
 * Split the same way as CrearInmuebleDto/ActualizarInmuebleDto: creating
 * requires both, editing does not, and a subclass cannot relax a parent's
 * required field into an optional one.
 *
 * `coPropertyId` is absent from all of this by design and must never be
 * added: the building comes from the request context, and accepting it in
 * the body would let a caller write into somebody else's tenant.
 */
class CamposTerceroDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tipoIdentificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  numeroIdentificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  digitoVerificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  telefono?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  direccion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  ciudad?: string;

  /* ── Facturación electrónica ──────────────────────────────────
   * Separada de la identificación general de arriba a propósito — ver la
   * nota en el schema de Tercero.
   */

  @IsOptional()
  @IsString()
  @MaxLength(20)
  facturacionTipoIdentificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  facturacionNumeroIdentificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  facturacionDigitoVerificacion?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  codigoCiiu?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  regimenVentas?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  responsabilidadesFiscales?: string[];

  @IsOptional()
  @IsBoolean()
  retieneRenta?: boolean;

  @IsOptional()
  @IsBoolean()
  retieneIca?: boolean;
}

/**
 * Creating a party. Person type and name are the two things it cannot be
 * created without — a company has no surname, so there is no name to split.
 */
export class CrearTerceroDto extends CamposTerceroDto {
  @IsIn(['natural', 'juridica'])
  tipoPersona: 'natural' | 'juridica';

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nombre: string;
}

/**
 * Editing a party. `estado` is here, and it is the only way one is retired:
 * `inactivo` stops it being offered as a new unit's holder, without touching
 * a single document that already names it — see the note on the schema for
 * why history must never rewrite itself. There is no delete.
 */
export class ActualizarTerceroDto extends CamposTerceroDto {
  @IsOptional()
  @IsIn(['natural', 'juridica'])
  tipoPersona?: 'natural' | 'juridica';

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nombre?: string;

  @IsOptional()
  @IsIn(['activo', 'inactivo'])
  estado?: 'activo' | 'inactivo';
}

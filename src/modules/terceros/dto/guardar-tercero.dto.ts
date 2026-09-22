// src/modules/terceros/dto/guardar-tercero.dto.ts
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
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
  /* ── Nombre ───────────────────────────────────────────────────
   * Split fields for a `natural` party — see the note on `Tercero.name`.
   * `nom1`/`ape1` are what DIAN requires (PrimerNombre/PrimerApellido);
   * `nom2`/`ape2` are optional, same as its OtrosNombres/SegundoApellido.
   * `razonSocial` is the `juridica` equivalent. Whichever pair applies wins
   * over a directly-sent `nombre` — see `TercerosService.resolverNombre`.
   */

  @IsOptional()
  @IsString()
  @MaxLength(100)
  nom1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  nom2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ape1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ape2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  razonSocial?: string;

  /** Free text always — the "Titular" screen now fills it from the DIAN
   *  tipos-identificación catalog (`GET /catalogos/tipos-identificacion`),
   *  but nothing here enforces that shape, same reasoning as `ciudad`. */
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

  /** More than one inbox for the same party — see the note on
   *  `Tercero.emails`. Each entry is validated as its own address; the
   *  frontend splits a single comma-separated field into this list. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsEmail({}, { each: true })
  @MaxLength(120, { each: true })
  emails?: string[];

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

  /** DANE municipio code, from the same catalog pick that filled `ciudad`. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  ciudadCodigo?: string;

  /** DANE department code — saved alongside the city, not derived from it
   *  on every read. See the note on `Tercero.cityDepartmentCode`. */
  @IsOptional()
  @IsString()
  @MaxLength(2)
  ciudadDepartamentoCodigo?: string;

  /* ── Facturación electrónica ──────────────────────────────────
   * Separada de la identificación general de arriba a propósito — ver la
   * nota en el schema de Tercero.
   */

  /** Same DIAN catalog as `tipoIdentificacion` above. */
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
 * Creating a party. `tipoPersona` is the one thing it cannot be created
 * without. A name is also required, but not necessarily THIS field —
 * `nombre` is optional here on purpose: `TercerosService.create` accepts it
 * as a fallback only when `nom1`+`ape1` (natural) or `razonSocial`
 * (jurídica) are absent, and rejects the request if NEITHER path yields a
 * name.
 */
export class CrearTerceroDto extends CamposTerceroDto {
  @IsIn(['natural', 'juridica'])
  tipoPersona: 'natural' | 'juridica';

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nombre?: string;
}

/**
 * Editing a party. There is no `estado` here on purpose: a party can never
 * be retired through this endpoint — every Tercero stays `activo` for as
 * long as it exists, and there is no delete either. `status` on the schema
 * still allows `inactive`, kept only for whatever a party has already
 * carried in from before this rule, never reachable going forward.
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
}

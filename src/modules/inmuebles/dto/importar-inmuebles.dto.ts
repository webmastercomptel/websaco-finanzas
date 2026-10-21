// src/modules/inmuebles/dto/importar-inmuebles.dto.ts
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Reads a blank or whitespace-only cell, or a JSON `null`, as "not sent"
 * (`undefined`) BEFORE the type rules run. Needed on the non-string optional columns because the
 * pipeline would otherwise coerce `""` into `0` (`@Type(() => Number)`) or
 * reject the WHOLE file (`@IsIn`, `@IsBoolean`) over one empty cell — and on
 * an update a spurious `0` would overwrite the stored area. String columns
 * are handled by `InmueblesService.importar` itself. Reads the raw value from
 * `obj` because `value` has already been through `@Type`.
 */
const CeldaVaciaComoAusente = () =>
  Transform(
    ({ obj, key, value }: { obj: object; key: string; value: unknown }) => {
      const cruda = (obj as Record<string, unknown>)[key];
      const ausente =
        cruda === null || (typeof cruda === 'string' && cruda.trim() === '');
      return ausente ? undefined : value;
    },
  );

/**
 * One row of a bulk import: a unit and, inline, the party that answers for
 * it. Loading a building's roster is one act in practice — a spreadsheet has
 * one line per unit, owner included — even though the two are kept apart as
 * separate collections; see the note on the Tercero schema for why.
 */
export class FilaImportarInmuebleDto {
  /** The active coproperty's own `Copropiedad.codigo` — a whole-file safety
   *  check on top of the tenancy law (never what resolves the tenant), so a
   *  file meant for a different building fails loudly, before anything is
   *  written, instead of silently patching this coproperty's roster with
   *  another's — see `InmueblesService.importar`. */
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigoCopropiedad: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo: string;

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

  @CeldaVaciaComoAusente()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  area?: number;

  @CeldaVaciaComoAusente()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  coeficiente?: number;

  @CeldaVaciaComoAusente()
  @IsOptional()
  @IsIn(['propietario', 'arrendatario'])
  tipoTitular?: 'propietario' | 'arrendatario';

  @CeldaVaciaComoAusente()
  @IsOptional()
  @IsBoolean()
  resideEnElInmueble?: boolean;

  @CeldaVaciaComoAusente()
  @IsOptional()
  @IsIn(['vigente', 'juridico', 'dificil_recaudo'])
  estadoCartera?: 'vigente' | 'juridico' | 'dificil_recaudo';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contacto?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observaciones?: string;

  /* ── El titular, en la misma fila ──────────────────────────────
   * Ninguno de estos campos es obligatorio: una fila puede describir una
   * inmueble sin papeles todavía, el mismo caso que ya contempla Tercero.
   *
   * nom1Titular/ape1Titular (persona natural) o razonSocialTitular (persona
   * jurídica) son las columnas actuales de la plantilla — ver
   * `resolverNombreTercero`. `nombreTitular` sigue aceptándose como
   * respaldo para plantillas viejas ya en circulación que no tienen las
   * columnas separadas; nunca compite con ellas si están presentes.
   */

  @IsOptional()
  @IsString()
  @MaxLength(100)
  nom1Titular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  nom2Titular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ape1Titular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  ape2Titular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  razonSocialTitular?: string;

  /** @deprecated Respaldo para plantillas viejas — ver la nota arriba. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nombreTitular?: string;

  /** DIAN código (e.g. "13", "31") — validated against the catalog in
   *  `InmueblesService.validarFila`, same as the manual Titular form's
   *  dropdown; a code that doesn't exist there fails only this row. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tipoIdentificacionTitular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  numeroIdentificacionTitular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  digitoVerificacionTitular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  emailTitular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  telefonoTitular?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  direccionTitular?: string;

  /** DANE código de municipio — resolved to its name and department code by
   *  `InmueblesService.validarFila`, same lookup the manual form's
   *  cascading Departamento/Ciudad selector does; nothing else in the row
   *  names the department, it always comes from this code. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  ciudadTitular?: string;
}

/**
 * The file is parsed into rows on the frontend (see the note there on why),
 * so this endpoint only ever sees plain JSON — never a multipart upload.
 */
export class ImportarInmueblesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FilaImportarInmuebleDto)
  filas: FilaImportarInmuebleDto[];
}

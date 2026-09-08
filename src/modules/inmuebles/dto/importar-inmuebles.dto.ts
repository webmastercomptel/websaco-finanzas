// src/modules/inmuebles/dto/importar-inmuebles.dto.ts
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';

/**
 * One row of a bulk import: a unit and, inline, the party that answers for
 * it. Loading a building's roster is one act in practice — a spreadsheet has
 * one line per unit, owner included — even though the two are kept apart as
 * separate collections; see the note on the Tercero schema for why.
 */
export class FilaImportarInmuebleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigo: string;

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

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  coeficiente?: number;

  @IsOptional()
  @IsIn(['propietario', 'arrendatario'])
  tipoTitular?: 'propietario' | 'arrendatario';

  @IsOptional()
  @IsBoolean()
  resideEnElInmueble?: boolean;

  @IsOptional()
  @IsIn(['al_dia', 'juridico', 'dificil_recaudo'])
  estadoCartera?: 'al_dia' | 'juridico' | 'dificil_recaudo';

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
   *  `InmueblesService.resolverTitular`, same as the manual Titular form's
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
   *  `InmueblesService.resolverTitular`, same lookup the manual form's
   *  cascading Departamento/Ciudad selector does; nothing else in the row
   *  names the department, it always comes from this code. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  ciudadTitular?: string;

  /**
   * Recurring monthly amounts, same pair shape `ValoresRecurrentesService`
   * already uses — the frontend resolves each sheet column ("cargo-1",
   * "cargo-2"…) to a `conceptoId` using the coproperty's own concept order
   * before this DTO ever sees it (see `inmuebles-importar.tsx`); this side
   * only ever deals in real ids, never column positions.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CargoImportadoDto)
  cargos?: CargoImportadoDto[];
}

class CargoImportadoDto {
  @IsMongoId()
  conceptoId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monto: number;
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

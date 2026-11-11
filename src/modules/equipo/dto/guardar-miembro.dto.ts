// src/modules/equipo/dto/guardar-miembro.dto.ts
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { MAX_CLAVES_ASIGNABLES } from '../../casl/permisos-catalogo';

/** `trim` for the strings a person types; leaves non-strings for the validator to reject. */
const recortar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Emails are stored lowercased; normalizing on the way in keeps lookups exact. */
const correoNormalizado = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const ID_HEX = /^[0-9a-f]{24}$/i;

/**
 * Body of `POST /equipo`.
 *
 * What it does NOT have is the point: no `perfil` (staff created here are always
 * `personal`), no `alcance`/`copropiedadId` (always this coproperty, taken from
 * the request context), no `esAdministradorPlataforma`, and no `password` (the
 * identity gets a random one nobody sees). The global `forbidNonWhitelisted`
 * pipe turns any of those into a 400 instead of ignoring them.
 */
export class CrearMiembroEquipoDto {
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre: string;

  @Transform(correoNormalizado)
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** Roles of THIS coproperty (adm_roles ids). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(ID_HEX, { each: true, message: 'cada rol debe ser un id válido' })
  rolIds?: string[];

  /**
   * Permission keys of any offered module (Finanzas and Administración)
   * granted directly, on top of the roles'. The size limit is derived from the
   * catalogs, with room for stored keys that travel back untouched.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CLAVES_ASIGNABLES)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permisos?: string[];

  /**
   * Explicit consent to attach an account that ALREADY exists for this email.
   * Without it an existing account is a 409, never a silent takeover.
   */
  @IsOptional()
  @IsBoolean()
  vincularExistente?: boolean;
}

/**
 * Body of `PATCH /equipo/:id`. Every field optional; `rolIds` and `permisos`
 * REPLACE the stored lists when present (an empty array clears it), and absent
 * means untouched. The account's email is not editable here: it is the person's
 * sign-in, and the same account may serve other buildings.
 */
export class ActualizarMiembroEquipoDto {
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(ID_HEX, { each: true, message: 'cada rol debe ser un id válido' })
  rolIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CLAVES_ASIGNABLES)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  permisos?: string[];
}

// src/modules/integraciones-panel/dto/actualizar-vinculo.dto.ts
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  MaxLength,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';
import { ID_REGISTRO_REGEX } from '../id-registro';

const recortar = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** `:id` of `PUT integraciones/panel/registros/:id/vinculo`. */
export class RegistroPanelParamDto {
  @Matches(ID_REGISTRO_REGEX)
  id!: string;
}

/**
 * Body of the link write. `sistema` is not restricted here: a system this
 * module does not store is a 422 from the service, not a validation error.
 */
export class ActualizarVinculoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  sistema!: string;

  /** The other system's record id, or null to unlink. Required either way. */
  @ValidateIf((_objeto, valor) => valor !== null)
  @Transform(recortar)
  @IsString()
  @Matches(ID_REGISTRO_REGEX)
  registroId!: string | null;

  /** Overwrite a different existing link. */
  @IsOptional()
  @IsBoolean()
  forzar?: boolean;

  /** With `registroId: null`: unlink only if the current value is this one. */
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @Matches(ID_REGISTRO_REGEX)
  esperado?: string;
}

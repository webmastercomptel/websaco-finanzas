import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  ROLES_RESIDENTE_CARPETA,
  TIPOS_AUDIENCIA_CARPETA,
  type RolResidenteCarpeta,
  type TipoAudienciaCarpeta,
} from '../../../database/schemas/administracion/documento-carpeta.schema';

/**
 * One rule of a folder's ACL, as a tagged union flattened into one object:
 * `{ tipo: 'rol', rolId }` or `{ tipo: 'residentes', rol }`. The conditional
 * validators make each shape require its own field; the service rejects the
 * mixed ones (a `rol` rule carrying `rol`, a residents rule that writes) and
 * checks that `rolId` belongs to the active coproperty.
 */
export class AclCarpetaDto {
  @IsIn(TIPOS_AUDIENCIA_CARPETA)
  tipo: TipoAudienciaCarpeta;

  @ValidateIf((a: AclCarpetaDto) => a.tipo === 'rol')
  @IsMongoId()
  rolId?: string;

  @ValidateIf((a: AclCarpetaDto) => a.tipo === 'residentes')
  @IsIn(ROLES_RESIDENTE_CARPETA)
  rol?: RolResidenteCarpeta;

  @IsBoolean()
  puedeLeer: boolean;

  @IsBoolean()
  puedeEscribir: boolean;
}

/** Body of `POST /documentos/carpetas`. The tenant is never part of it. */
export class CrearCarpetaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  nombre: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  descripcion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(40)
  icono?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  color?: string;

  /** Optional hint; the service slugifies it and makes it unique anyway. */
  @IsString()
  @IsOptional()
  @MaxLength(120)
  slug?: string;

  @IsMongoId()
  @IsOptional()
  parentId?: string | null;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AclCarpetaDto)
  @IsOptional()
  acls?: AclCarpetaDto[];
}

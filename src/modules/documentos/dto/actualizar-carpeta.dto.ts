import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AclCarpetaDto } from './guardar-carpeta.dto';

/**
 * Body of `PATCH /documentos/carpetas/:id`: name, description and/or rules. The
 * slug never changes, so already-shared links keep working. Sending `acls: []`
 * switches the folder back to inheriting.
 */
export class ActualizarCarpetaDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsOptional()
  nombre?: string;

  @IsString()
  @MaxLength(500)
  @IsOptional()
  descripcion?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => AclCarpetaDto)
  @IsOptional()
  acls?: AclCarpetaDto[];
}

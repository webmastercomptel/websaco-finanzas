import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Body of `PATCH /documentos/:id`: featured flag, tags and/or the folder to move it to. */
export class ActualizarDocumentoDto {
  @IsBoolean()
  @IsOptional()
  destacado?: boolean;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  @IsOptional()
  etiquetas?: string[];

  /** Slug of the folder to move the document into. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsOptional()
  carpeta?: string;
}

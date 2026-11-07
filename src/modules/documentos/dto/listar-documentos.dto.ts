import {
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Query of both document lists (staff and resident portal). There is
 * deliberately no coproperty parameter: the tenant is always the active one, and
 * the global `forbidNonWhitelisted` pipe rejects a client that still sends it.
 */
export class ListarDocumentosDto {
  /** Folder slug, or `todos` (the default) for every folder the caller may read. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  @IsOptional()
  carpeta?: string;

  @IsString()
  @MaxLength(100)
  @IsOptional()
  q?: string;
}

/** Query of both folder lists: the children of `parent`, or the root when absent. */
export class ListarCarpetasDto {
  @IsMongoId()
  @IsOptional()
  parent?: string;
}

// src/modules/copropiedades/dto/listar-copropiedades.dto.ts
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Query parameters for the coproperty listing. Same shape as Inmuebles'. */
export class ListarCopropiedadesDto {
  /** Matches code or name. */
  @IsOptional()
  @IsString()
  buscar?: string;

  @IsOptional()
  @IsIn(['activo', 'inactivo', 'todos'])
  estado?: 'activo' | 'inactivo' | 'todos';

  /** Narrows to the siblings of one managing company — what the "copiar
   *  configuración desde otra copropiedad" picker uses to only offer
   *  buildings that actually share an entidad administradora with the one
   *  being filled. */
  @IsOptional()
  @IsMongoId()
  entidadAdministradoraId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  porPagina?: number;
}

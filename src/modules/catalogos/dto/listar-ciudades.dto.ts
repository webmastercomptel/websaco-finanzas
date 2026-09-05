// src/modules/catalogos/dto/listar-ciudades.dto.ts
import { IsOptional, IsString, Length } from 'class-validator';

export class ListarCiudadesDto {
  /** DANE department code (2 digits) — narrows the 1123-row catalog to one
   *  department's, the same pairing `CiudadDian.departamentoCodigo` carries. */
  @IsOptional()
  @IsString()
  @Length(2, 2)
  departamentoCodigo?: string;
}

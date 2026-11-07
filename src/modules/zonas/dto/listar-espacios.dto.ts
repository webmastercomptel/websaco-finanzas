// src/modules/zonas/dto/listar-espacios.dto.ts
import { IsIn, IsOptional } from 'class-validator';

export const CATEGORIAS_ESPACIO = ['todos', 'deportes', 'social'] as const;

/**
 * Query of `GET /portal/espacios`. `categoria` is the resident's two-way split:
 * `deportes` is the `deportiva` type, `social` is every other one.
 */
export class ListarEspaciosDto {
  @IsIn(CATEGORIAS_ESPACIO)
  @IsOptional()
  categoria?: (typeof CATEGORIAS_ESPACIO)[number];
}

import { IsIn, IsNotEmpty, IsString } from 'class-validator';

const TIPOS_VALIDOS = ['FC', 'RC', 'NC', 'ND', 'NT'] as const;

/** DTO for GET /consultas/movimiento-contable/buscar — lookup by document. */
export class BuscarMovimientoContableDto {
  @IsIn(TIPOS_VALIDOS)
  tipoDocumento!: 'FC' | 'RC' | 'NC' | 'ND' | 'NT';

  @IsNotEmpty()
  @IsString()
  numeroCompleto!: string;
}

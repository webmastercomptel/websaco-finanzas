// src/modules/facturacion-bloque/dto/listar-bloques.dto.ts
import { IsIn, IsOptional } from 'class-validator';
import {
  ESTADOS_BLOQUE,
  TIPOS_BLOQUE,
  type EstadoBloque,
  type TipoBloque,
} from '../../../database/schemas/administracion/bloque-facturacion.schema';
import { TIPOS_DE_RESIDENTE } from '../facturacion-bloque-acceso';

/**
 * Query of the resident list. No coproperty parameter: the tenant is always the
 * active one, and the global `forbidNonWhitelisted` pipe rejects a client that
 * still sends it. Only the kinds a resident can ever be offered are valid: a
 * receipt is not a filter value, it is a 400.
 */
export class ListarMisDocumentosDto {
  @IsIn(TIPOS_DE_RESIDENTE)
  @IsOptional()
  tipo?: (typeof TIPOS_DE_RESIDENTE)[number];
}

/** Query of the staff list: both filters optional, unknown values are a 400. */
export class ListarBloquesDto {
  @IsIn(TIPOS_BLOQUE)
  @IsOptional()
  tipo?: TipoBloque;

  @IsIn(ESTADOS_BLOQUE)
  @IsOptional()
  estado?: EstadoBloque;
}

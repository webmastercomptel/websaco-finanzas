// src/modules/envio-facturas/dto/marcar-envio-facturas.dto.ts
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  Matches,
} from 'class-validator';

/**
 * Exactly 24 hex characters, either case. Not `@IsMongoId`: validator's hex check
 * accepts a `0x` prefix, so a 24-character `0x…` string would pass as an id.
 */
export const ID_HEX = /^[0-9a-f]{24}$/i;

/** How many invoices one "mark" call may name. A whole lote goes by `loteId`. */
export const MAX_FACTURAS_POR_MARCADO = 500;

/**
 * Body of `POST envio-facturas/marcar`: EITHER every invoice of a billing run
 * (`loteId`) OR a hand-picked list (`facturaIds`). Which one (and not both, not
 * neither) is checked by the service so the answer is a clear 400.
 */
export class MarcarEnvioFacturasDto {
  @IsOptional()
  @Matches(ID_HEX, { message: 'loteId no es un id válido' })
  loteId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_FACTURAS_POR_MARCADO)
  @ArrayUnique()
  @Matches(ID_HEX, {
    each: true,
    message: 'facturaIds contiene un id inválido',
  })
  facturaIds?: string[];
}

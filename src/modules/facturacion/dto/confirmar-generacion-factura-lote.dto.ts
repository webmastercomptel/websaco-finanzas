import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsNotEmpty,
  IsString,
  ValidateNested,
} from 'class-validator';

/** One Factura's own confirmation, inside a batch `confirmar-generacion`
 *  call — Factura is batch-only (see `LotesController`), so unlike the
 *  other five document types there is no single-document confirm route to
 *  reuse `ConfirmarGeneracionDocumentoDto` from. */
export class ConfirmarGeneracionFacturaItemDto {
  @IsMongoId()
  facturaId: string;

  @IsString()
  @IsNotEmpty()
  objectPath: string;
}

export class ConfirmarGeneracionFacturaLoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ConfirmarGeneracionFacturaItemDto)
  facturas: ConfirmarGeneracionFacturaItemDto[];
}

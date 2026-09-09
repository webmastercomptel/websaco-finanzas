import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AplicacionSolicitadaDto } from '../../recibos/dto/aplicacion-solicitada.dto';

/**
 * Applies part or all of a Recibo's `montoSinAplicar` against open cartera,
 * creating a Nota de Anticipo as its own document. Same shape and same
 * "exactly one of the two" rule as `CrearReciboDto`'s own
 * `aplicaciones`/`aplicacionAutomatica` pair — enforced in
 * `NotasAnticipoService.crear()`, not here, since it spans two fields.
 */
export class CrearNotaAnticipoDto {
  /** Which configured tipo de documento (código, category IN — same
   *  category a Recibo's own código uses) numbers this nota. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsMongoId()
  reciboOrigenId: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AplicacionSolicitadaDto)
  aplicaciones?: AplicacionSolicitadaDto[];

  @IsOptional()
  @IsBoolean()
  aplicacionAutomatica?: boolean;
}

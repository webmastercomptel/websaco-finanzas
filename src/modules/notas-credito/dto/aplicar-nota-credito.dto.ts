import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { AplicacionSolicitadaDto } from '../../recibos/dto/aplicacion-solicitada.dto';

/** Reuses `AplicacionSolicitadaDto` from the Recibos module directly — same
 *  shape (`{ tipoDocumento: 'FV', documentoId, montoAplicado }`), same
 *  precedent as reusing `cruce.util.ts` cross-module (design §4: "same
 *  aplicaciones?/aplicacionAutomatica? shape as AplicarReciboDto"). */
export class AplicarNotaCreditoDto {
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

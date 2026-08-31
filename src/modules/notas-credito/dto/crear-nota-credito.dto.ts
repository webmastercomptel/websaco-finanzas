import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DistribucionLineaDto } from './distribucion-linea.dto';

/** Declared independently from the schema's own `MOTIVOS_NOTA_CREDITO` —
 *  same precedent as `CrearReciboDto`'s `MEDIOS_PAGO` vs. the schema's
 *  `PAYMENT_METHODS`: the DTO layer stays decoupled from persistence types,
 *  even when the literal values coincide. */
export const MOTIVOS_NOTA_CREDITO = [
  'error_facturacion',
  'descuento_comercial',
  'anulacion_documento',
  'otro',
] as const;

export class CrearNotaCreditoDto {
  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  facturaId: string;

  @IsIn(MOTIVOS_NOTA_CREDITO)
  motivo: (typeof MOTIVOS_NOTA_CREDITO)[number];

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  montoTotal: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DistribucionLineaDto)
  distribucion: DistribucionLineaDto[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  observaciones?: string;
}

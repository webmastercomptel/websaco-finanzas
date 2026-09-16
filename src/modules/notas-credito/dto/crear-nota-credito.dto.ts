import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DistribucionLineaDto } from './distribucion-linea.dto';

/** Declared independently from the schema's own `MOTIVOS_NOTA_CREDITO` —
 *  same precedent as `CrearReciboDto`'s `MEDIOS_PAGO` vs. the schema's
 *  `PAYMENT_METHODS`: the DTO layer stays decoupled from persistence types,
 *  even when the literal values coincide. These 5 codes ARE DIAN's own
 *  "Concepto de Corrección para Notas crédito" catalog (Anexo 1.8-2021
 *  §13.3.4) — see the schema's own docblock for the full citation. */
export const MOTIVOS_NOTA_CREDITO = [
  'devolucion_parcial',
  'anulacion_factura',
  'descuento',
  'ajuste_precio',
  'otro',
] as const;

export class CrearNotaCreditoDto {
  /** Which configured tipo de documento (código, category NC) numbers this
   *  nota — a building may have more than one configured under NC. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  facturaId: string;

  /** The date the user declares for this note — validated in the service
   *  against the coproperty's current billing period, mirroring
   *  `CrearReciboDto.fechaRecibo`. */
  @IsDateString()
  fecha: string;

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

import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
import { AplicacionSolicitadaDto } from './aplicacion-solicitada.dto';

export const MEDIOS_PAGO = [
  'transferencia',
  'cheque',
  'pse',
  'efectivo',
] as const;

export const DESTINOS_SOBRANTE = ['anticipo', 'otros_ingresos'] as const;

export class CrearReciboDto {
  /** Which configured tipo de documento (código, category IN) numbers this
   *  receipt — a building may have more than one, e.g. "RC" and "RT". */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  terceroId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  montoRecibido: number;

  @IsDateString()
  fechaRecibo: string;

  @IsIn(MEDIOS_PAGO)
  medioPago: (typeof MEDIOS_PAGO)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cuentaDestino?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  referencia?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  observaciones?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AplicacionSolicitadaDto)
  aplicaciones?: AplicacionSolicitadaDto[];

  @IsOptional()
  @IsBoolean()
  aplicacionAutomatica?: boolean;

  /** Explicit user confirmation (manual mode only — see
   *  `RecibosService.crear()`'s own note) to send the shortfall between
   *  `aplicaciones`' sum and `montoRecibido` to the coproperty's own
   *  `discountsDebitAccount`, instead of rejecting the request outright.
   *  Never inferred/automatic: a receipt short by a small amount could be a
   *  digitación error, not a deliberate write-off — the caller must ask. */
  @IsOptional()
  @IsBoolean()
  confirmarDescuentoFaltante?: boolean;

  /** Manual mode only: where a payment SURPLUS goes (`montoRecibido` >
   *  what `aplicaciones` asked for) — `'anticipo'` reproduces today's
   *  always-silent behavior (client credit, re-appliable later);
   *  `'otros_ingresos'` books it as revenue instead, to
   *  `discountsCreditAccount`'s sibling `otherIncomeCreditAccount`, and it
   *  stops being available for a future Nota de Anticipo. Required
   *  whenever a manual submission produces a surplus — never inferred,
   *  same reasoning as `confirmarDescuentoFaltante`. Automática/FIFO never
   *  asks: leaving cash unapplied there is routine, not a caller decision. */
  @IsOptional()
  @IsIn(DESTINOS_SOBRANTE)
  destinoSobrante?: (typeof DESTINOS_SOBRANTE)[number];
}

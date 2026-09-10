import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MEDIOS_PAGO } from './crear-recibo.dto';

/** Opens a new Recibos-por-lote batch — the fields common to every row the
 *  file will carry (the file itself only varies inmueble/fecha/valor per
 *  row, see `CargarFilasLoteRecibosDto`). */
export class CrearLoteRecibosDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsIn(MEDIOS_PAGO)
  medioPago: (typeof MEDIOS_PAGO)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  cuentaDestino?: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  totalDigitado: number;
}

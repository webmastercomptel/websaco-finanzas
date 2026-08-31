import { Type } from 'class-transformer';
import { IsMongoId, IsNumber, IsPositive } from 'class-validator';

/** One line of `distribucion` in `CrearNotaCreditoDto` — how much of the
 *  Nota Crédito corrects a given concepto on the anchor invoice (design
 *  §3.2, §6). */
export class DistribucionLineaDto {
  @IsMongoId()
  conceptoId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  monto: number;
}

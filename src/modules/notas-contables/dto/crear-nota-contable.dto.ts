import {
  IsMongoId,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CrearNotaContableDto {
  /** Which configured tipo de documento (código, category NT) numbers this
   *  nota — a building may have more than one configured under NT. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  conceptoOrigenId: string;

  @IsMongoId()
  conceptoDestinoId: string;

  @Type(() => Number)
  @IsPositive()
  monto: number;

  @IsString()
  @MinLength(1)
  descripcion: string;
}

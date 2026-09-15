import { Type } from 'class-transformer';
import {
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CrearNotaDebitoDto {
  /** Which configured tipo de documento (código, category ND) numbers this
   *  nota — a building may have more than one configured under ND. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  conceptoId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  total: number;

  @IsDateString()
  fechaCargo: string;

  @IsDateString()
  fechaVencimiento: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;
}

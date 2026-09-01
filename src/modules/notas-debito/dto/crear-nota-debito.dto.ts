import { Type } from 'class-transformer';
import {
  IsDateString,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';

export class CrearNotaDebitoDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;
}

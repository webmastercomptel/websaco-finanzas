import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class NovedadFilaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  inmuebleCodigo: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nombreConcepto: string;

  @Type(() => Number)
  @IsNumber()
  monto: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  observacion?: string;
}

export class CargarNovedadesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => NovedadFilaDto)
  filas: NovedadFilaDto[];
}

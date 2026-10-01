import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
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
  @IsInt()
  // Never negative — see `MENSAJE_MONTO_NEGATIVO` in `novedad-linea.dto.ts`.
  @Min(0, {
    message:
      'El monto de un cargo no puede ser negativo; un saldo a favor se registra como anticipo',
  })
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

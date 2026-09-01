import { IsMongoId, IsPositive, IsString, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CrearNotaContableDto {
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

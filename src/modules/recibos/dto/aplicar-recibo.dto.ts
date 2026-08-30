import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import { AplicacionSolicitadaDto } from './aplicacion-solicitada.dto';

export class AplicarReciboDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AplicacionSolicitadaDto)
  aplicaciones?: AplicacionSolicitadaDto[];

  @IsOptional()
  @IsBoolean()
  aplicacionAutomatica?: boolean;
}

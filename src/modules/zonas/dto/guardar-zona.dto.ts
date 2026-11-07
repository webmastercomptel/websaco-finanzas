// src/modules/zonas/dto/guardar-zona.dto.ts
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ESTADOS_ZONA,
  TIPOS_ZONA,
  type EstadoZona,
  type TipoZona,
} from '../../../database/schemas/administracion/zona.schema';

/**
 * Body of `POST /zonas-comunes`. The tenant and the `ZC-001` code are never part
 * of it: the first comes from the request context, the second from a sequence.
 */
export class CrearZonaDto {
  @IsString()
  @IsNotEmpty()
  nombre: string;

  @IsIn(TIPOS_ZONA)
  tipo: TipoZona;

  @IsString()
  @IsOptional()
  descripcion?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  capacidad?: number;

  /** Free text; an `HH:MM - HH:MM` range in it drives the availability view. */
  @IsString()
  @IsOptional()
  horario?: string;

  @IsBoolean()
  @IsOptional()
  requiereReserva?: boolean;

  /** `null` is accepted (and stored) as "free"; omitting it does the same. */
  @ValidateIf((_, valor) => valor !== null)
  @IsNumber()
  @IsOptional()
  costo?: number | null;

  /** `null` is accepted (and stored) as "no image"; omitting it does the same. */
  @IsString()
  @IsOptional()
  imagen?: string | null;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  reglas?: string[];

  @IsIn(ESTADOS_ZONA)
  @IsOptional()
  estado?: EstadoZona;
}

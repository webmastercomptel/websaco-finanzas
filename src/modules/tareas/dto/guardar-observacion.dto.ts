// src/modules/tareas/dto/guardar-observacion.dto.ts
import { IsNotEmpty, IsString } from 'class-validator';

/** Body of `POST /tareas/:id/observaciones`. */
export class CrearObservacionDto {
  @IsString()
  @IsNotEmpty()
  texto: string;
}

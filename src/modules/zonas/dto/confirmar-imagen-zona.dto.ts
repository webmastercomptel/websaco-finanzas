// src/modules/zonas/dto/confirmar-imagen-zona.dto.ts
import { IsNotEmpty, IsString } from 'class-validator';

/** Body of step 2: the `storagePath` that step 1 returned. */
export class ConfirmarImagenZonaDto {
  @IsString()
  @IsNotEmpty()
  storagePath: string;
}

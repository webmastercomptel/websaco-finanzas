// src/modules/organos/dto/guardar-integrante-organo.dto.ts
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /organos/:organo/integrantes`. Only the shape is checked here:
 * whether the id is well formed and qualifies is the service's 400, so a
 * foreign or malformed id gets the same answer.
 */
export class GuardarIntegranteOrganoDto {
  @IsString()
  @IsNotEmpty()
  terceroId: string;
}

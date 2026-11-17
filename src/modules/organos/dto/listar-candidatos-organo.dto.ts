// src/modules/organos/dto/listar-candidatos-organo.dto.ts
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Query of `GET /organos/candidatos`: name or unit code of who may be seated. */
export class ListarCandidatosOrganoDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

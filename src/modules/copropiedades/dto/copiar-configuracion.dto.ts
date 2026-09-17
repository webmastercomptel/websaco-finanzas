// src/modules/copropiedades/dto/copiar-configuracion.dto.ts
import { IsMongoId } from 'class-validator';

/** What `POST /copropiedades/:id/copiar-configuracion` accepts: which
 *  sibling coproperty (same entidad administradora) to fill this one from —
 *  see `CopropiedadesService.copiarConfiguracion`. */
export class CopiarConfiguracionDto {
  @IsMongoId()
  origenId: string;
}

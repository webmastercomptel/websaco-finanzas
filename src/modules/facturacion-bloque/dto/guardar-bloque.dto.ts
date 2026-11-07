// src/modules/facturacion-bloque/dto/guardar-bloque.dto.ts
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  TIPOS_BLOQUE_SUBIBLES,
  type TipoBloqueSubible,
} from '../../../database/schemas/administracion/bloque-facturacion.schema';

/**
 * Body of step 1 of an upload: declares the PDF so the backend can register the
 * block as `pendiente` and sign a write URL for exactly that content type. The
 * 200 MB limit is checked in the service (and again on the real object size at
 * `confirmar`), where it can answer with a message instead of a generic 400.
 */
export class CrearBloqueDto {
  /** Receipts are internal: a `recibo` batch can no longer be uploaded. */
  @IsIn(TIPOS_BLOQUE_SUBIBLES, {
    message: 'Solo se pueden subir facturas o estados de cuenta',
  })
  tipo: TipoBloqueSubible;

  /** Free label of the period, e.g. "2026-07". */
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  periodo: string;

  /** File name as the admin knows it. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  nombre: string;

  /** Only PDFs: the signed URL is pinned to this exact type. */
  @IsIn(['application/pdf'], { message: 'Solo se aceptan archivos PDF' })
  mimeType: 'application/pdf';

  @IsInt()
  @Min(1)
  tamanoBytes: number;
}

import {
  IsDateString,
  IsIn,
  IsMongoId,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CrearNotaContableDto {
  /** Which configured tipo de documento (código, category NT) numbers this
   *  nota — a building may have more than one configured under NT. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsMongoId()
  inmuebleId: string;

  /** Which specific Factura/NotaDebito this reclassification's per-document
   *  `CarteraPorDocumento` effect lands on — the same document the user
   *  picked from "Cartera Pendiente del Inmueble" in the form. A
   *  reclasificación is scoped to ONE document, never spread across
   *  however many happen to share the origin concepto at this inmueble. */
  @IsIn(['FV', 'ND'])
  tipoDocumento: 'FV' | 'ND';

  @IsMongoId()
  documentoId: string;

  /** The date the user declares for this note — validated in the service
   *  against the coproperty's current billing period, mirroring
   *  `CrearNotaCreditoDto.fecha`. */
  @IsDateString()
  fecha: string;

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

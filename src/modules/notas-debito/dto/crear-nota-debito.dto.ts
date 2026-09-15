import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Declared independently from the schema's own `MOTIVOS_NOTA_DEBITO` — same
 *  precedent as `CrearNotaCreditoDto`'s own `MOTIVOS_NOTA_CREDITO`. These 4
 *  codes ARE DIAN's own "Concepto de Corrección para Notas débito" catalog
 *  (Anexo 1.8-2021 §13.2.5) — see the schema's own docblock
 *  (`nota-debito.schema.ts`) for the full citation. */
export const MOTIVOS_NOTA_DEBITO = [
  'intereses',
  'gastos_por_cobrar',
  'cambio_valor',
  'otro',
] as const;

export class CrearNotaDebitoDto {
  /** Which configured tipo de documento (código, category ND) numbers this
   *  nota — a building may have more than one configured under ND. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsMongoId()
  inmuebleId: string;

  @IsMongoId()
  conceptoId: string;

  @IsIn(MOTIVOS_NOTA_DEBITO)
  motivo: (typeof MOTIVOS_NOTA_DEBITO)[number];

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  total: number;

  @IsDateString()
  fechaCargo: string;

  @IsDateString()
  fechaVencimiento: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  descripcion?: string;
}

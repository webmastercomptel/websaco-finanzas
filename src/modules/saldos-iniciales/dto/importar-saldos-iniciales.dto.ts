import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsMongoId,
  IsNumber,
  IsString,
  Min,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** One cargo's amount in a Saldo Inicial row — the frontend resolves each
 *  sheet column to a `conceptoId` using the coproperty's own concept order
 *  before this DTO ever sees it, same convention `importar-inmuebles.dto.ts`
 *  already uses for its own `cargos`. */
export class CargoSaldoInicialDto {
  @IsMongoId()
  conceptoId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  monto: number;
}

/**
 * One row of a bulk Saldos Iniciales import. The file is parsed into rows on
 * the frontend (same convention as `ImportarInmueblesDto`) — this endpoint
 * only ever sees plain JSON, never a multipart upload.
 */
export class FilaSaldoInicialDto {
  /** The active coproperty's own `Copropiedad.code` — a row-level safety
   *  check on top of the tenancy law (never what resolves the tenant), so a
   *  file pasted into the wrong coproperty's import screen fails loudly per
   *  row instead of silently loading someone else's cartera. */
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigoCopropiedad: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  codigoInmueble: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  tipoDocumento: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  numero: string;

  @IsDateString()
  fecha: string;

  @IsDateString()
  fechaVencimiento: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CargoSaldoInicialDto)
  cargos: CargoSaldoInicialDto[];
}

export class ImportarSaldosInicialesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FilaSaldoInicialDto)
  filas: FilaSaldoInicialDto[];
}

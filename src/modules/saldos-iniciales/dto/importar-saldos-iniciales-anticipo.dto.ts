import {
  IsArray,
  IsDateString,
  IsNumber,
  IsString,
  Min,
  MaxLength,
  MinLength,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One row of a bulk Saldos Iniciales de Anticipo import — an opening credit
 * balance a unit already had in the client's previous system. The file is
 * parsed into rows on the frontend, same convention as
 * `FilaSaldoInicialDto`. `tipoDocumento`/`numero` are the client's own
 * previous-system identity for this credit (typically `'RC'` and that
 * system's receipt number) — free text, never validated against this
 * system's own document types, same reasoning as `FilaSaldoInicialDto.tipoDocumento`.
 */
export class FilaSaldoInicialAnticipoDto {
  /** The active coproperty's own `Copropiedad.code` — same row-level safety
   *  check as `FilaSaldoInicialDto.codigoCopropiedad`. */
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

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  valor: number;
}

export class ImportarSaldosInicialesAnticipoDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FilaSaldoInicialAnticipoDto)
  filas: FilaSaldoInicialAnticipoDto[];

  /** No row's `fecha` may be later than this — the moment the new system
   *  starts governing this coproperty's anticipo data. */
  @IsDateString()
  fechaCorte: string;

  /** Must equal the exact sum of every row's `valor` — a hash-total check
   *  the implementer types by hand, so a bad row is caught immediately by
   *  the person who knows the right number, not inferred from the file. */
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  valorTotal: number;
}

import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AplicacionSolicitadaDto } from '../../recibos/dto/aplicacion-solicitada.dto';

/**
 * Applies part or all of a Recibo's `montoSinAplicar` against open cartera,
 * creating a Nota de Anticipo as its own document. Same shape and same
 * "exactly one of the two" rule as `CrearReciboDto`'s own
 * `aplicaciones`/`aplicacionAutomatica` pair — enforced in
 * `NotasAnticipoService.crear()`, not here, since it spans two fields.
 */
export class CrearNotaAnticipoDto {
  /** Which configured tipo de documento (código, category NT — "Nota
   *  Contable") numbers this nota. NOT category IN: a Nota de Anticipo
   *  never touches a bank account — the cash already arrived earlier, in
   *  the original Recibo de Caja. Creating one only reclassifies cartera
   *  against that Recibo's leftover anticipo, the same kind of pure
   *  reclassification a Nota Contable does. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  codigo: string;

  @IsMongoId()
  reciboOrigenId: string;

  /** The document's own business date — same pattern as `NotaDebito`'s
   *  `fechaCargo`/`Recibo`'s `receivedDate`. NOT defaulted to "now" server
   *  side: this document can legitimately be issued to catch up on an
   *  earlier period, and its date is what both `issueDate` and the posted
   *  asiento's `date` use — never the real instant, so it lands in the
   *  right period regardless of when it's actually keyed in. */
  @IsDateString()
  fechaEmision: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AplicacionSolicitadaDto)
  aplicaciones?: AplicacionSolicitadaDto[];

  @IsOptional()
  @IsBoolean()
  aplicacionAutomatica?: boolean;
}

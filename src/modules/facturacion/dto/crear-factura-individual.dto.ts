import { IsMongoId } from 'class-validator';

/**
 * Unlike `CrearLoteDto`, no dates/discount/mora fields — a Factura
 * Individual always inherits the CURRENT period's own values verbatim from
 * the last `consolidado` lote (see `LotesFacturacionService.crearIndividual`),
 * so there is nothing for the caller to declare beyond which inmueble.
 */
export class CrearFacturaIndividualDto {
  @IsMongoId()
  inmuebleId: string;
}

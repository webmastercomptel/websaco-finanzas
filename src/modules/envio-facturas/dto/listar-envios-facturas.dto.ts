// src/modules/envio-facturas/dto/listar-envios-facturas.dto.ts
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { ESTADOS_ENVIO_FACTURA } from '../../../database/schemas/facturacion/envio-factura.schema';
import { ID_HEX } from './marcar-envio-facturas.dto';

/** Query of `GET envio-facturas`: the queue, optionally narrowed. */
export class ListarEnviosFacturasDto {
  @IsOptional()
  @IsIn([...ESTADOS_ENVIO_FACTURA])
  estado?: (typeof ESTADOS_ENVIO_FACTURA)[number];

  @IsOptional()
  @Matches(ID_HEX, { message: 'loteId no es un id válido' })
  loteId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  porPagina?: number;
}

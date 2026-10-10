import { Transform } from 'class-transformer';
import { IsBoolean, IsMongoId, IsOptional } from 'class-validator';

const aBooleano = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
};

/**
 * Optional filters for `GET /saldos-iniciales-anticipo`. Mirrors the Recibos
 * `conAnticipoDisponible` and Saldos Iniciales `conSaldoPendiente` queries so
 * the Anticipos bandeja can ask for "opening anticipos that still have
 * something to apply" the same way it asks for Recibos.
 */
export class ListarSaldosInicialesAnticipoDto {
  @IsOptional()
  @IsMongoId()
  inmuebleId?: string;

  /** Only `activo` documents whose LIVE `saldoDisponible` is above zero. */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  conSaldoDisponible?: boolean;
}

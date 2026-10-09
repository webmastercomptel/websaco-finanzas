import { Transform } from 'class-transformer';
import { IsBoolean, IsMongoId, IsOptional } from 'class-validator';

const aBooleano = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === undefined) return undefined;
  return value === true || value === 'true';
};

/**
 * Optional filters for `GET /saldos-iniciales`. Mirrors the facturas /
 * notas-débito list queries so the cartera-pendiente screens can ask for
 * "this unit's saldos iniciales that still owe something" the same way they
 * ask for its facturas and notas débito.
 */
export class ListarSaldosInicialesDto {
  @IsOptional()
  @IsMongoId()
  inmuebleId?: string;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  conSaldoPendiente?: boolean;
}

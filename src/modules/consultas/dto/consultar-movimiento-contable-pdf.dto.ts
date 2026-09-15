import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import type { MovimientoContable } from '../../../contracts';

const TIPOS_VALIDOS: MovimientoContable['tipoDocumento'][] = [
  'FC',
  'RC',
  'NC',
  'ND',
  'NT',
  'NA',
];

/** Query DTO for GET /consultas/movimiento-contable/pdf — same desde/hasta
 *  as the main list route, plus the on-screen narrowing filters
 *  (tipo/inmueble/número) so the printed PDF can match what's actually on
 *  screen. Kept separate from `ConsultarMovimientoContableDto` because the
 *  main list route never needs these — that page narrows client-side over
 *  the whole period it already fetched. */
export class ConsultarMovimientoContablePdfDto {
  @IsDateString()
  desde!: string;

  @IsDateString()
  hasta!: string;

  /** Filters to one document type — the on-screen filter's own PDF export. */
  @IsOptional()
  @IsIn(TIPOS_VALIDOS)
  tipo?: MovimientoContable['tipoDocumento'];

  /** Filters to one inmueble's código — the on-screen filter's own PDF
   *  export. Not an id: `MovimientoContable` only ever carries the resolved
   *  código, never a raw inmuebleId, so filtering here matches on the same
   *  field the report itself exposes. */
  @IsOptional()
  @IsString()
  inmuebleCodigo?: string;

  /** Substring match against `numeroDocumento`, case-insensitive — same
   *  semantics as the on-screen filter's own `includes()`. */
  @IsOptional()
  @IsString()
  numero?: string;
}

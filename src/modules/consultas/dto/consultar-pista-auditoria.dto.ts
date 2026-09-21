import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { TipoDocumentoPistaAuditoria } from '../../../contracts';

/** The 6 in-scope document type labels, exactly as `TipoDocumentoPistaAuditoria`
 *  spells them — `class-validator`'s `@IsIn` needs a runtime array, a type
 *  alone can't validate anything. */
export const TIPOS_DOCUMENTO_PISTA_AUDITORIA: TipoDocumentoPistaAuditoria[] = [
  'Factura',
  'Recibo',
  'Nota Débito',
  'Nota Crédito',
  'Nota Contable',
  'Nota de Anticipo',
];

/**
 * Query DTO for GET /consultas/pista-auditoria — every filter optional and
 * combinable. Named `Consultar…` rather than `Filtros…` to match this
 * folder's own dominant convention (`consultas/dto/` is `consultar-*` in
 * every sibling but one — `filtros-*` is the OTHER, unrelated `auditoria`
 * module's own convention).
 */
export class ConsultarPistaAuditoriaDto {
  /** Account id — exact match against the event's own actor. */
  @IsOptional()
  @IsString()
  usuarioId?: string;

  @IsOptional()
  @IsIn(TIPOS_DOCUMENTO_PISTA_AUDITORIA)
  tipoDocumento?: TipoDocumentoPistaAuditoria;

  /** Partial/contains match against `numeroCompleto`. */
  @IsOptional()
  @IsString()
  numero?: string;

  /** Inclusive lower bound on the event's own `fecha`. */
  @IsOptional()
  @IsDateString()
  desde?: string;

  /** Inclusive upper bound on the event's own `fecha`. */
  @IsOptional()
  @IsDateString()
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pagina?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  porPagina?: number;
}

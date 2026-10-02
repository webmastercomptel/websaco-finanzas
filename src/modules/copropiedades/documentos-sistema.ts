// src/modules/copropiedades/documentos-sistema.ts
import type { CategoriaDocumento } from '../../database/schemas/numeracion/consecutivo-documento.schema';

export interface DocumentoSistema {
  categoria: CategoriaDocumento;
  codigo: string;
  nombreDocumento: string;
  comprobanteContable: string | null;
}

/**
 * The ConsecutivoDocumento types every coproperty needs before it can issue
 * anything. One list for both `CopropiedadesService` (seeds them on create)
 * and the backfill script for coproperties that predate that seeding, so the
 * two can never drift apart.
 *
 * NA (Nota de Anticipo) is filed under category NT, same as NT itself — see
 * the schema comment on `ConsecutivoDocumento.categoria` and
 * `DocumentosService.getHighestIssuedNumber`'s note on why NA's real
 * documents still live in their own collection despite the shared category.
 */
export const DOCUMENTOS_SISTEMA: readonly DocumentoSistema[] = [
  {
    categoria: 'FV',
    codigo: 'FV',
    nombreDocumento: 'Cobro Expensas Comunes',
    comprobanteContable: '01',
  },
  {
    categoria: 'IN',
    codigo: 'RC',
    nombreDocumento: 'Recibo de Caja',
    comprobanteContable: null,
  },
  {
    categoria: 'NC',
    codigo: 'NC',
    nombreDocumento: 'Nota Credito',
    comprobanteContable: null,
  },
  {
    categoria: 'ND',
    codigo: 'ND',
    nombreDocumento: 'Nota Debito',
    comprobanteContable: null,
  },
  {
    categoria: 'NT',
    codigo: 'NA',
    nombreDocumento: 'Nota de Anticipo',
    comprobanteContable: null,
  },
  {
    categoria: 'NT',
    codigo: 'NT',
    nombreDocumento: 'Nota Contable',
    comprobanteContable: null,
  },
];

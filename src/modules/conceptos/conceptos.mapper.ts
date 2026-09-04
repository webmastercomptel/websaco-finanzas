// src/modules/conceptos/conceptos.mapper.ts
import { Types } from 'mongoose';
import { codigoDeCuentaContable } from '../../common/utils/mapper.utils';
import type { ConceptoCobro as ConceptoContract } from '../../contracts';
import type { ConceptoCobroDocument } from '../../database/schemas/conceptos/concepto-cobro.schema';
import type { CuentaContableDocument } from '../../database/schemas/contabilidad/cuenta-contable.schema';

/**
 * Extracts the account id regardless of whether `cuentaDebitoId`/
 * `cuentaCreditoId` arrived populated (a `CuentaContableDocument`, from
 * `findAll`'s `.populate()`) or raw (an `ObjectId`, from `create`/`update`,
 * which never populate). Either way the id is what the edit form needs to
 * preselect the account.
 */
const idDeCuenta = (
  valor: CuentaContableDocument | Types.ObjectId | null,
): string | null => {
  if (!valor) return null;
  return valor instanceof Types.ObjectId
    ? valor.toString()
    : valor._id.toString();
};

/**
 * Maps a billing-concept document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md.
 */
export const toConcepto = (doc: ConceptoCobroDocument): ConceptoContract => ({
  id: doc._id.toString(),
  copropiedadId: doc.coPropertyId.toString(),
  nombre: doc.name,
  tipo: doc.kind,
  tasaImpuesto: doc.taxRate,
  orden: doc.sortOrder,
  cuentaDebitoId: idDeCuenta(doc.cuentaDebitoId),
  cuentaDebitoCodigo: codigoDeCuentaContable(doc.cuentaDebitoId),
  cuentaCreditoId: idDeCuenta(doc.cuentaCreditoId),
  cuentaCreditoCodigo: codigoDeCuentaContable(doc.cuentaCreditoId),
  liquidaMora: doc.liquidaMora,
  cargaXls: doc.availableAsNovedad,
  sistema: doc.isSystem,
});

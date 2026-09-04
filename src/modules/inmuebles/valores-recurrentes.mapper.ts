// src/modules/inmuebles/valores-recurrentes.mapper.ts
import type { ValorRecurrente as ValorRecurrenteContract } from '../../contracts';
import type { ConceptoCobroDocument } from '../../database/schemas/conceptos/concepto-cobro.schema';

/** `monto` is read from a lookup, not the concepto document itself — see
 *  `ValoresRecurrentesService.obtener`, which builds `montoPorConcepto`
 *  from the coproperty's actual `ValorRecurrente` rows and defaults every
 *  concept without one to 0. */
export const toValorRecurrente = (
  concepto: ConceptoCobroDocument,
  monto: number,
): ValorRecurrenteContract => ({
  conceptoId: concepto._id.toString(),
  conceptoNombre: concepto.name,
  monto,
});

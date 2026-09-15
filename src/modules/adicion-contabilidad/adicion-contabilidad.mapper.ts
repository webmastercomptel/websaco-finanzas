import type { LoteContabilidad as LoteContabilidadContract } from '../../contracts';
import type { LoteContabilidadDocument } from '../../database/schemas/contabilidad/lote-contabilidad.schema';

export const toLoteContabilidad = (
  doc: LoteContabilidadDocument,
): LoteContabilidadContract => ({
  id: doc._id.toString(),
  numero: doc.number,
  periodoDesde: doc.periodStart.toISOString(),
  periodoHasta: doc.periodEnd.toISOString(),
  totalAsientos: doc.totalAsientos,
  fechaGeneracion: (
    doc as unknown as { createdAt: Date }
  ).createdAt.toISOString(),
});

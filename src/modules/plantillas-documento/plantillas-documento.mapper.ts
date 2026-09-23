import type { PlantillaDocumento as PlantillaContract } from '../../contracts';
import type { PlantillaDocumentoDocument } from '../../database/schemas/documentos/plantilla-documento.schema';

/**
 * Maps a template document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in CLAUDE.md.
 */
export const toPlantilla = (
  doc: PlantillaDocumentoDocument,
): PlantillaContract => ({
  tipoDocumento: doc.tipoDocumento,
  docDefinition: doc.docDefinition,
  fechaActualizacion: doc.updatedAt.toISOString(),
});

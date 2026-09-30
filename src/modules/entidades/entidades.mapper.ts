// src/modules/entidades/entidades.mapper.ts
import type { EntidadAdministradora as EntidadContract } from '../../contracts';
import type { EntidadAdministradoraDocument } from '../../database/schemas/entidades/entidad-administradora.schema';

/**
 * Maps a managing-entity document to the Spanish API contract.
 *
 * Persistence and the API are both Spanish — see "the contract law" in
 * CLAUDE.md. This mapper's job is type conversion, never language
 * translation.
 */
export const toEntidad = (
  doc: EntidadAdministradoraDocument,
): EntidadContract => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  nombre: doc.nombre,
  nit: doc.nit,
  digitoVerificacion: doc.digitoVerificacion,
  email: doc.email,
  telefono: doc.telefono,
  estado: doc.estado === 'active' ? 'activo' : 'inactivo',
});

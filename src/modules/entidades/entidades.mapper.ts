// src/modules/entidades/entidades.mapper.ts
import type { EntidadAdministradora as EntidadContract } from '../../contracts';
import type { EntidadAdministradoraDocument } from '../../database/schemas/entidades/entidad-administradora.schema';

/**
 * Maps a managing-entity document to the Spanish API contract.
 *
 * Persistence is English, the API is Spanish, and this is the only place the
 * two meet — see "the contract law" in AGENTS.md.
 */
export const toEntidad = (
  doc: EntidadAdministradoraDocument,
): EntidadContract => ({
  id: doc._id.toString(),
  codigo: doc.code,
  nombre: doc.name,
  nit: doc.taxId,
  digitoVerificacion: doc.taxIdVerificationDigit,
  email: doc.email,
  telefono: doc.phone,
  estado: doc.status === 'active' ? 'activo' : 'inactivo',
});

import type { Tecnico } from '../../contracts';
import type { TecnicoDocument } from '../../database/schemas/administracion/tecnico.schema';

/** Maps a Tecnico document to the API contract; persisted names already ARE the contract names. */
export const toTecnico = (doc: TecnicoDocument): Tecnico => ({
  id: doc._id.toString(),
  nombre: doc.nombre,
  especialidad: doc.especialidad,
  email: doc.email,
});

import type { Equipo } from '../../contracts';
import type { EquipoDocument } from '../../database/schemas/administracion/equipo.schema';

/** Maps an Equipo document to the API contract; only the date needs conversion. */
export const toEquipo = (doc: EquipoDocument): Equipo => ({
  id: doc._id.toString(),
  nombre: doc.nombre,
  tipo: doc.tipo,
  ubicacion: doc.ubicacion,
  marca: doc.marca,
  modelo: doc.modelo,
  serial: doc.serial,
  fechaInstalacion: doc.fechaInstalacion
    ? doc.fechaInstalacion.toISOString()
    : null,
  estado: doc.estado,
  notas: doc.notas ?? null,
});

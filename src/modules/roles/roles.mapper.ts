// src/modules/roles/roles.mapper.ts
import type { Permiso, Rol } from '../../contracts';
import type { RolDocument } from '../../database/schemas/administracion/rol.schema';
import type { PermisoCatalogo } from '../casl/permisos-catalogo';

/** Role document -> API contract; `usuarios` is counted by the service. */
export const toRol = (doc: RolDocument, usuarios: number): Rol => ({
  id: doc._id.toString(),
  codigo: doc.codigo,
  nombre: doc.nombre,
  descripcion: doc.descripcion,
  color: doc.color,
  usuarios,
  permisos: doc.permisos,
  esPredeterminado: doc.esPredeterminado,
  fechaCreacion: (
    (doc as unknown as { createdAt?: Date }).createdAt ?? new Date()
  ).toISOString(),
});

export const toPermiso = (permiso: PermisoCatalogo): Permiso => ({
  id: permiso.id,
  nombre: permiso.nombre,
  descripcion: permiso.descripcion,
  modulo: permiso.modulo,
});

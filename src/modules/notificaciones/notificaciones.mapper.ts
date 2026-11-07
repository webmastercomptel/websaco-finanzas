// src/modules/notificaciones/notificaciones.mapper.ts
import type { Notificacion } from '../../contracts';
import type { NotificacionDocument } from '../../database/schemas/administracion/notificacion.schema';

export const toNotificacion = (doc: NotificacionDocument): Notificacion => ({
  id: doc._id.toString(),
  tipo: doc.tipo,
  titulo: doc.titulo,
  descripcion: doc.descripcion,
  fecha: (
    (doc as unknown as { createdAt?: Date }).createdAt ?? new Date()
  ).toISOString(),
  leida: doc.leida,
});

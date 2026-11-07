// src/database/schemas/administracion/notificacion.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type NotificacionDocument = HydratedDocument<Notificacion>;

export const TIPOS_NOTIFICACION = [
  'pqr',
  'reserva',
  'mantenimiento',
  'pago',
  'documento',
  'tarea',
  'anuncio',
  'actividad',
] as const;

export type TipoNotificacion = (typeof TIPOS_NOTIFICACION)[number];

/**
 * One entry of a person's in-app inbox: per account AND per coproperty, never a
 * broadcast. Produced as a side effect of the building-management modules
 * (a new PQR, an assigned task, an announcement...) and read from the bell.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'adm_notificaciones',
  versionKey: false,
})
export class Notificacion {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Account', required: true })
  accountId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: TIPOS_NOTIFICACION })
  tipo: TipoNotificacion;

  @Prop({ required: true })
  titulo: string;

  @Prop({ default: '' })
  descripcion: string;

  @Prop({ required: true, default: false })
  leida: boolean;
}

export const NotificacionSchema = SchemaFactory.createForClass(Notificacion);
NotificacionSchema.index({
  copropiedadId: 1,
  accountId: 1,
  leida: 1,
  createdAt: -1,
});

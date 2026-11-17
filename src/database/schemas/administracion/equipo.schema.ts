// src/database/schemas/administracion/equipo.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EquipoDocument = HydratedDocument<Equipo>;

export const ESTADOS_EQUIPO = [
  'operativo',
  'fuera_de_servicio',
  'dado_de_baja',
] as const;
export type EstadoEquipo = (typeof ESTADOS_EQUIPO)[number];

/**
 * A piece of equipment of the building (elevator, pump, generator...) that
 * maintenance work can be linked to. It is retired with `dado_de_baja` rather
 * than deleted once it has history, so its hoja de vida survives.
 */
@Schema({ timestamps: true, collection: 'adm_equipos', versionKey: false })
export class Equipo {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  nombre: string;

  @Prop({ default: '' })
  tipo: string;

  @Prop({ default: '' })
  ubicacion: string;

  @Prop({ default: '' })
  marca: string;

  @Prop({ default: '' })
  modelo: string;

  @Prop({ default: '' })
  serial: string;

  /** Business date (UTC midnight), not a timestamp. */
  @Prop({ type: Date, default: null })
  fechaInstalacion: Date | null;

  @Prop({ type: String, enum: ESTADOS_EQUIPO, default: 'operativo' })
  estado: EstadoEquipo;

  @Prop({ type: String, default: null })
  notas: string | null;
}

export const EquipoSchema = SchemaFactory.createForClass(Equipo);
EquipoSchema.index({ copropiedadId: 1, nombre: 1 });

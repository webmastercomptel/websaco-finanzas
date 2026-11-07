// src/database/schemas/administracion/tecnico.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type TecnicoDocument = HydratedDocument<Tecnico>;

/**
 * An external technician or provider the building calls for repairs and
 * maintenance. Just a contact (name, specialty, email): it has no sign-in, so it
 * is never an `Account` and is only ever reached by plain email.
 */
@Schema({ timestamps: true, collection: 'adm_tecnicos', versionKey: false })
export class Tecnico {
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  nombre: string;

  @Prop({ default: '' })
  especialidad: string;

  @Prop({ default: '' })
  email: string;
}

export const TecnicoSchema = SchemaFactory.createForClass(Tecnico);
TecnicoSchema.index({ copropiedadId: 1 });

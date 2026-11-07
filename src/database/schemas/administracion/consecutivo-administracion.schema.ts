// src/database/schemas/administracion/consecutivo-administracion.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ConsecutivoAdministracionDocument =
  HydratedDocument<ConsecutivoAdministracion>;

/**
 * Atomic sequence behind the human-readable codes of the building-management
 * records (`PQR-007`, `MNT-012`, `DOC-031`...). One document per prefix.
 *
 * The sequence is global per prefix, not per coproperty, exactly as in the
 * system this was ported from: existing codes keep working and the migration
 * only has to park each counter above the highest code already issued
 * (`asegurarConsecutivoMinimo`). Unrelated to the financial `Consecutivo*`
 * collections, whose numbering is legally regulated and per coproperty.
 */
@Schema({ collection: 'adm_consecutivos', versionKey: false })
export class ConsecutivoAdministracion {
  @Prop({ required: true, unique: true, trim: true })
  clave: string;

  @Prop({ required: true, default: 0 })
  valor: number;
}

export const ConsecutivoAdministracionSchema = SchemaFactory.createForClass(
  ConsecutivoAdministracion,
);

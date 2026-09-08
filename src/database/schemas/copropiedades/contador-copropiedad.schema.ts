// src/database/schemas/copropiedades/contador-copropiedad.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ContadorCopropiedadDocument = HydratedDocument<ContadorCopropiedad>;

/**
 * The single counter behind `Copropiedad.code`'s auto-generated sequential
 * value — same shape and reasoning as `ContadorEntidadAdministradora`.
 */
@Schema({ collection: 'contadores_copropiedades' })
export class ContadorCopropiedad {
  @Prop({ required: true, default: 0 })
  valor: number;
}

export const ContadorCopropiedadSchema =
  SchemaFactory.createForClass(ContadorCopropiedad);

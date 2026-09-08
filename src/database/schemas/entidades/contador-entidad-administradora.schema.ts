// src/database/schemas/entidades/contador-entidad-administradora.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ContadorEntidadAdministradoraDocument =
  HydratedDocument<ContadorEntidadAdministradora>;

/**
 * The single counter behind `EntidadAdministradora.code`'s auto-generated
 * sequential value ("0001", "0002", ...). Exactly one document ever exists
 * in this collection — `EntidadesService` always queries it with an empty
 * filter, so every call after the first upsert hits that same row.
 *
 * Incremented via `findOneAndUpdate` + `$inc` in the same atomic operation,
 * never "read the max code, then write max+1": that check-then-write
 * pattern leaves a window where two concurrent creates compute the same
 * next number — the exact failure mode `NumeracionService` already
 * documents for invoice numbering, avoided here the same way.
 */
@Schema({ collection: 'contadores_entidades_administradoras' })
export class ContadorEntidadAdministradora {
  @Prop({ required: true, default: 0 })
  valor: number;
}

export const ContadorEntidadAdministradoraSchema =
  SchemaFactory.createForClass(ContadorEntidadAdministradora);

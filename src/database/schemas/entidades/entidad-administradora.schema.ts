// src/database/schemas/entidades/entidad-administradora.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EntidadAdministradoraDocument =
  HydratedDocument<EntidadAdministradora>;

/**
 * A company that administers several coproperties.
 *
 * It exists to solve one concrete problem: a firm managing ten buildings does
 * not want to maintain its staff's access building by building. Assigning a
 * person to the company instead of to each property means the grant follows the
 * company's portfolio — take on an eleventh building and everyone already has
 * it, with nothing to edit.
 *
 * Note what it is NOT for. "One login instead of ten" is already solved by an
 * account holding several assignments; this is about not maintaining those
 * assignments one by one.
 *
 * It is also not a tenant. The tenant is always the coproperty: money, units
 * and documents belong to a building, and a company changing hands must not
 * move anybody's ledger.
 */
@Schema({ timestamps: true, collection: 'entidades_administradoras' })
export class EntidadAdministradora {
  @Prop({ required: true, unique: true, trim: true })
  code: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, default: null, trim: true })
  taxId: string | null;

  @Prop({ type: String, default: null, trim: true })
  taxIdVerificationDigit: string | null;

  @Prop({ type: String, default: null, trim: true })
  email: string | null;

  @Prop({ type: String, default: null, trim: true })
  phone: string | null;

  /**
   * Inactive suspends the access its assignments grant, without touching the
   * buildings themselves. A coproperty outlives whoever administers it, so
   * deactivating a company must never stop a building from being billed — only
   * stop that company's staff from being the ones doing it.
   */
  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  status: 'active' | 'inactive';
}

export const EntidadAdministradoraSchema = SchemaFactory.createForClass(
  EntidadAdministradora,
);

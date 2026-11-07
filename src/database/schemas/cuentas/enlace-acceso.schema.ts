// src/database/schemas/cuentas/enlace-acceso.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type EnlaceAccesoDocument = HydratedDocument<EnlaceAcceso>;

/**
 * Server-side record behind a passwordless sign-in link sent in a notification
 * email. The link carries an opaque random token; only its SHA-256 hash is
 * stored, so a copy of this collection cannot be turned into sessions.
 *
 * Ephemeral by design: the TTL index removes the document when `expiraEn`
 * passes, and the migration does not carry these over.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'enlaces_acceso',
})
export class EnlaceAcceso {
  @Prop({ required: true, unique: true })
  tokenHash: string;

  @Prop({ type: Types.ObjectId, ref: 'Account', required: true })
  accountId: Types.ObjectId;

  /** The coproperty the link lands in (set active after sign-in). */
  @Prop({ type: Types.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  /** Frontend path to open after sign-in; always a same-site relative path. */
  @Prop({ required: true })
  destino: string;

  @Prop({ required: true })
  expiraEn: Date;
}

export const EnlaceAccesoSchema = SchemaFactory.createForClass(EnlaceAcceso);
EnlaceAccesoSchema.index({ expiraEn: 1 }, { expireAfterSeconds: 0 });

// src/database/schemas/cuentas/enlace-ingreso.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type EnlaceIngresoDocument = HydratedDocument<EnlaceIngreso> & {
  createdAt: Date;
};

/** Who asked for the link: the person themselves, or staff resending it. */
export const ORIGENES_ENLACE_INGRESO = ['autoservicio', 'personal'] as const;
export type OrigenEnlaceIngreso = (typeof ORIGENES_ENLACE_INGRESO)[number];

/**
 * Server-side record behind a resident's SIGN-IN link (`/ingreso#<token>`).
 *
 * Deliberately not `enlaces_acceso`: that one is account-bound, reusable for
 * days and pinned to a coproperty. This one comes BEFORE any account exists, is
 * single use, lives minutes and is bound to an address. Mixing both would
 * weaken both.
 *
 * Only the SHA-256 of the 32-byte token is stored, so a copy of this collection
 * cannot be turned into sessions. `correo` (normalized) is kept because the
 * Account of a first-time resident is created from it at redeem; it already
 * sits in plaintext in `terceros`, it lives at most the link's lifetime plus
 * the TTL sweep, and it is never logged or audited. `clave` is its hash, the
 * key used to invalidate earlier links.
 *
 * Validity never relies on the TTL: every consume checks `expiraEn`.
 */
@Schema({
  timestamps: { createdAt: true, updatedAt: false },
  collection: 'enlaces_ingreso',
  versionKey: false,
})
export class EnlaceIngreso {
  @Prop({ required: true, unique: true })
  tokenHash: string;

  /** `claveCorreo(correo)`. */
  @Prop({ required: true })
  clave: string;

  /** The normalized address the link was sent to. */
  @Prop({ required: true })
  correo: string;

  @Prop({
    type: String,
    enum: ORIGENES_ENLACE_INGRESO,
    default: 'autoservicio',
  })
  origen: OrigenEnlaceIngreso;

  /** The staff account of a resend; null for a self-service request. */
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Account', default: null })
  solicitadoPor: Types.ObjectId | null;

  @Prop({ type: Date, required: true })
  expiraEn: Date;

  /** Set by the atomic consume, or by a newer link for the same address. */
  @Prop({ type: Date, default: null })
  usadoEn: Date | null;
}

export const EnlaceIngresoSchema = SchemaFactory.createForClass(EnlaceIngreso);

// "Invalidate this address's earlier unused links" on every new link.
EnlaceIngresoSchema.index({ clave: 1, usadoEn: 1 });
// Bounded growth: the row goes at expiry.
EnlaceIngresoSchema.index({ expiraEn: 1 }, { expireAfterSeconds: 0 });

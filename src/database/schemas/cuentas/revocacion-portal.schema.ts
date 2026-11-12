// src/database/schemas/cuentas/revocacion-portal.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type RevocacionPortalDocument = HydratedDocument<RevocacionPortal>;

/**
 * Staff's decision that an ADDRESS no longer enters the resident portal of ONE
 * coproperty. One row per revoke event: lifting it flips `activa` and records
 * who and when, so the history is native and nothing is ever deleted.
 *
 * Keyed by `claveCorreo(address)`, never by the address itself, and never by
 * party or account: the revocation must outlive a record edit (remove the
 * address, add it back, sell the unit to someone carrying it) and applies to
 * the legacy `Tercero.accountId` link through the same key. It touches no
 * `Asignacion`, no Firebase identity and no invoice e-mail.
 */
@Schema({ collection: 'revocaciones_portal' })
export class RevocacionPortal {
  @Prop({ type: SchemaTypes.ObjectId, ref: 'Copropiedad', required: true })
  copropiedadId: Types.ObjectId;

  /** `claveCorreo(address)`: the only identity of the address stored here. */
  @Prop({ type: String, required: true })
  clave: string;

  /** True while the revocation applies; false once staff lifted it. */
  @Prop({ type: Boolean, required: true, default: true })
  activa: boolean;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Account', required: true })
  revocadaPor: Types.ObjectId;

  @Prop({ type: Date, required: true })
  revocadaEn: Date;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Account', default: null })
  levantadaPor: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  levantadaEn: Date | null;
}

export const RevocacionPortalSchema =
  SchemaFactory.createForClass(RevocacionPortal);

// At most ONE active revocation per (coproperty, address). A second revoke
// meets this index (E11000) and means "already revoked"; lifted rows pile up as
// history because they fall outside the partial filter.
RevocacionPortalSchema.index(
  { copropiedadId: 1, clave: 1 },
  { unique: true, partialFilterExpression: { activa: true } },
);

// The derivation asks "which coproperties revoked this address".
RevocacionPortalSchema.index({ clave: 1, activa: 1 });

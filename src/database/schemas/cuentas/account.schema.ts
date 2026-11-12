// src/database/schemas/cuentas/account.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AccountDocument = HydratedDocument<Account>;

/**
 * Somebody who signs in to operate this system.
 *
 * Staff (the administrator of one or more coproperties, operational personnel,
 * the platform operator) AND residents. An owner or tenant gets an account when
 * staff provision their sign-in (`/residentes`); it is linked through
 * `Tercero.accountId`, carries no permissions, and reaches only the `/portal/*`
 * routes, for the units it currently holds.
 *
 * Not the identity provider's record, but this system's own. The provider
 * answers "is this person who they claim to be"; this answers "and what may
 * they do here", which is a question only Finanzas can settle.
 */
@Schema({ timestamps: true, collection: 'accounts' })
export class Account {
  /**
   * Identity-provider uid — the stable join key. Matching on email alone would
   * break the day someone's address changes, and would silently follow the
   * address to whoever inherits it.
   */
  @Prop({ required: true, unique: true, trim: true })
  firebaseUid: string;

  /**
   * Lowercased on the way in. Email comparison is case-insensitive in practice,
   * and normalising at write time means no query has to remember that.
   */
  @Prop({ required: true, unique: true, trim: true, lowercase: true })
  email: string;

  @Prop({ required: true, trim: true })
  nombreCompleto: string;

  /**
   * Platform operator: sees every coproperty and bypasses assignments. This is
   * the vendor's own support account, not a customer's administrator — a
   * building's administrator is powerful within their building and nothing
   * outside it.
   */
  @Prop({ required: true, default: false })
  esAdministradorPlataforma: boolean;

  /**
   * Inactive locks the person out while keeping their name attached to
   * everything they did. Accounts are never removed: a voided invoice has to
   * keep pointing at whoever voided it.
   */
  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  estado: 'active' | 'inactive';

  /**
   * Proof that the person controls `email`: `claveCorreo(email)` at the moment
   * a sign-in link e-mailed to that address was redeemed. It only counts while
   * it still equals `claveCorreo(email)` (a proof for another address grants
   * nothing), and it is what lets the address on a holder record reach the
   * resident portal. Null until the first successful redeem.
   */
  @Prop({ type: String, default: null })
  correoProbadoClave: string | null;

  /** When the address was first proven; later redeems keep it. */
  @Prop({ type: Date, default: null })
  correoProbadoEn: Date | null;

  /** The last successful portal sign-in link redeem; feeds Residentes' «Entró». */
  @Prop({ type: Date, default: null })
  ultimoIngresoPortalEn: Date | null;
}

export const AccountSchema = SchemaFactory.createForClass(Account);

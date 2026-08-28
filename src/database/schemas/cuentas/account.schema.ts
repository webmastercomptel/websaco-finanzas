// src/database/schemas/cuentas/account.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AccountDocument = HydratedDocument<Account>;

/**
 * Somebody who signs in to operate this system.
 *
 * Everyone here is staff: the administrator of one or more coproperties, or the
 * platform operator. Unit owners and tenants are `Tercero` records and never
 * have an account — this product has no resident-facing side at all.
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
  fullName: string;

  /**
   * Platform operator: sees every coproperty and bypasses assignments. This is
   * the vendor's own support account, not a customer's administrator — a
   * building's administrator is powerful within their building and nothing
   * outside it.
   */
  @Prop({ required: true, default: false })
  isPlatformAdmin: boolean;

  /**
   * Inactive locks the person out while keeping their name attached to
   * everything they did. Accounts are never removed: a voided invoice has to
   * keep pointing at whoever voided it.
   */
  @Prop({ required: true, enum: ['active', 'inactive'], default: 'active' })
  status: 'active' | 'inactive';
}

export const AccountSchema = SchemaFactory.createForClass(Account);

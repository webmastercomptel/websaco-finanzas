// src/common/cuentas/cuenta.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';

@Injectable()
export class CuentaService {
  private readonly logger = new Logger(CuentaService.name);

  constructor(
    @InjectModel(Account.name)
    private readonly accounts: Model<AccountDocument>,
  ) {}

  /**
   * Finds the local account behind a verified token, or null if there is none.
   *
   * Two lookups, in order, and the order is the whole design:
   *
   *  1. By provider uid — the stable key. Once bound, it survives the person
   *     changing their email address.
   *  2. By email, only when no uid matches. This is how an account created in
   *     advance by an administrator, who typed an address and nothing else,
   *     gets claimed the first time that person signs in. The uid is written
   *     then, and from that point step 1 answers.
   *
   * The email fallback is safe here because the identity provider allows one
   * account per address: nobody can obtain a token for an address that already
   * belongs to someone else. It is a claim of a record prepared for you, not a
   * way to become somebody.
   *
   * Never creates an account. Somebody with a valid token and no record here is
   * authenticated and has access to nothing — which is the correct answer, not
   * an invitation to provision them.
   */
  async resolverPorToken(
    firebaseUid: string,
    email: string,
  ): Promise<AccountDocument | null> {
    const porUid = await this.accounts.findOne({ firebaseUid }).exec();
    if (porUid) return porUid;

    const normalizado = email.trim().toLowerCase();
    if (!normalizado) return null;

    const porEmail = await this.accounts.findOne({ email: normalizado }).exec();
    if (!porEmail) return null;

    // First sign-in: bind the account to the identity that just proved it owns
    // the address. Logged because it happens once per person and explains why
    // the record suddenly has a uid it did not have yesterday.
    porEmail.firebaseUid = firebaseUid;
    await porEmail.save();
    this.logger.log(
      `Cuenta ${normalizado} vinculada a la identidad ${firebaseUid}.`,
    );

    return porEmail;
  }
}

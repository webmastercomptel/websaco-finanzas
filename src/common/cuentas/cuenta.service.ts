// src/common/cuentas/cuenta.service.ts
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Account,
  AccountDocument,
} from '../../database/schemas/cuentas/account.schema';

/**
 * The placeholder uid of an account created ahead of its first sign-in — see
 * seed-admin.ts. Exact, per address: any other `pendiente:`-looking value is a
 * stored uid like any other and is never claimable.
 */
const marcadorPendiente = (emailNormalizado: string): string =>
  `pendiente:${emailNormalizado}`;

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
   *  2. By email, only when no uid matches, and only to CLAIM an account that
   *     is not bound to anyone yet (the `pendiente:` placeholder written by
   *     `seed:admin`). The uid is written then, and from that point step 1
   *     answers.
   *
   * An account already bound to a real uid is NEVER re-bound by email. The
   * provider's one-account-per-address rule only holds while the original
   * identity still exists with that address: once it is deleted or renamed —
   * or if the shared pool ever allows several accounts per address — a
   * different identity can carry the same email. Re-binding would then hand
   * the account (staff and platform admin included) to that identity and
   * unbind its owner. Such a token is refused with the guard's opaque 401.
   * There is no in-app re-bind: reconnecting a person whose identity was
   * genuinely recreated is a manual update of the Account's `firebaseUid`.
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

    const marcador = marcadorPendiente(normalizado);
    if (porEmail.firebaseUid !== marcador) {
      return this.rechazarReclamo(porEmail._id);
    }

    // First sign-in: bind the account to the identity that just proved it owns
    // the address. Compare-and-set on the placeholder, so two identities racing
    // for the same unclaimed account cannot both win.
    const reclamada = await this.accounts
      .findOneAndUpdate(
        { _id: porEmail._id, firebaseUid: marcador },
        { $set: { firebaseUid } },
        { new: true },
      )
      .exec();
    if (!reclamada) return this.rechazarReclamo(porEmail._id);

    // Logged because it happens once per person and explains why the record
    // suddenly has a uid it did not have yesterday.
    this.logger.log(
      `Cuenta ${String(reclamada._id)} vinculada a la identidad ${firebaseUid}.`,
    );
    return reclamada;
  }

  /**
   * A token whose email matches an account bound to another identity. Same
   * opaque 401 as any invalid token; the log names the account id, never the
   * address.
   */
  private rechazarReclamo(cuentaId: unknown): never {
    this.logger.warn(
      `Rechazado: otra identidad reclamó por correo la cuenta ya vinculada ${String(cuentaId)}.`,
    );
    throw new UnauthorizedException('Token de autenticación inválido');
  }
}

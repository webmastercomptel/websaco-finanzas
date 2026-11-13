// src/common/cuentas/enlace-acceso.service.ts
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Auth } from 'firebase-admin/auth';
import { Model, Types } from 'mongoose';
import {
  Account,
  type AccountDocument,
} from '../../database/schemas/cuentas/account.schema';
import {
  Asignacion,
  type AsignacionDocument,
} from '../../database/schemas/cuentas/asignacion.schema';
import {
  EnlaceAcceso,
  type EnlaceAccesoDocument,
} from '../../database/schemas/cuentas/enlace-acceso.schema';
import { AccesoService } from '../acceso/acceso.service';
import { FIREBASE_AUTH } from '../firebase/firebase.constants';
import { cuentaAdmiteSesionPorEnlace } from './politica-enlace';

/** How long a link works: long enough to click an old email, short enough to bound a forwarded one. */
const VIGENCIA_MS = 7 * 24 * 60 * 60 * 1000;

/** Same-site relative paths only: `/x`, never `//host`, `\host` or a full URL. */
const DESTINO_PROPIO = /^\/(?![/\\])[^\s\\]*$/;

const hashDe = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Passwordless sign-in links for notification emails ("open this task").
 *
 * A link is a bearer credential that lives for days in somebody's inbox, so it
 * is deliberately capped:
 * - Never for a platform admin, an inactive account, anyone holding a Finanzas
 *   permission in ANY coproperty they can reach, or anyone with an active
 *   non-'personal' (administrativo or company-wide) assignment anywhere. The
 *   custom token is a full session, not a session scoped to the link's
 *   building: `X-CoProperty-Id` can then name any coproperty the account
 *   reaches, so the check must cover all of them. A forwarded email must not be
 *   a way into the financial side; those people sign in normally. Residents and
 *   team members with no Finanzas key (Administración keys only) are the
 *   audience: since a `personal` member can now hold Finanzas keys, the first
 *   Finanzas key granted anywhere ends the link, built or already emailed.
 * - Checked twice: when the link is built, and again when it is redeemed, so a
 *   permission granted after the email went out removes the link's power.
 * - Only the SHA-256 of the token is stored, and the landing path must be a
 *   same-site relative path (no open redirect).
 *
 * Both methods are best-effort and never throw: `construir` answers null and the
 * caller falls back to a plain link; `canjear` answers null and the endpoint
 * says "invalid or expired". Redeeming mints a Firebase custom token for the
 * account's own uid — it reads and writes no Firebase user.
 */
@Injectable()
export class EnlaceAccesoService {
  private readonly logger = new Logger(EnlaceAccesoService.name);

  constructor(
    private readonly config: ConfigService,
    @InjectModel(EnlaceAcceso.name)
    private readonly enlaces: Model<EnlaceAccesoDocument>,
    @InjectModel(Account.name)
    private readonly cuentas: Model<AccountDocument>,
    @InjectModel(Asignacion.name)
    private readonly asignaciones: Model<AsignacionDocument>,
    private readonly acceso: AccesoService,
    @Inject(FIREBASE_AUTH) private readonly auth: Auth,
  ) {}

  /**
   * The account may use a link into this coproperty: the shared session policy
   * (`cuentaAdmiteSesionPorEnlace`, see the class docblock) plus the clause
   * that is this link's own: the account must already reach THIS coproperty.
   */
  private async cuentaPuedeUsarEnlace(
    cuenta: AccountDocument | null,
    copropiedadId: string,
  ): Promise<boolean> {
    if (!cuenta) return false;
    // Inactive and platform-admin accounts need no further query.
    if (
      !cuentaAdmiteSesionPorEnlace({
        cuenta,
        accesos: [],
        tieneNoPersonal: false,
      })
    ) {
      return false;
    }

    // Every coproperty the account reaches, not only the link's: the session
    // the link opens is not pinned to one building.
    const accesos = await this.acceso.copropiedadesDe(
      cuenta._id.toString(),
      false,
      cuenta,
    );
    if (!accesos.some((a) => a.copropiedadId === copropiedadId)) return false;
    // Any Finanzas key ends it, before the second query.
    if (
      !cuentaAdmiteSesionPorEnlace({ cuenta, accesos, tieneNoPersonal: false })
    ) {
      return false;
    }

    // An administrativo (or company-wide) grant can receive Finanzas keys at
    // any moment; such accounts sign in with their password, never a link.
    const administrativo = await this.asignaciones
      .exists({
        accountId: cuenta._id,
        estado: 'active',
        perfil: { $ne: 'personal' },
      })
      .exec();
    return cuentaAdmiteSesionPorEnlace({
      cuenta,
      accesos,
      tieneNoPersonal: !!administrativo,
    });
  }

  /** Builds `<frontend>/auth/enlace?token=…`, or null when a link must not be issued. */
  async construir(
    accountId: string,
    copropiedadId: string,
    destino: string,
    vigenciaMs: number = VIGENCIA_MS,
  ): Promise<string | null> {
    try {
      const frontendUrl = this.config.get<string>('app.frontendUrl');
      if (!frontendUrl || !DESTINO_PROPIO.test(destino)) return null;

      const cuenta = await this.cuentas.findById(accountId).exec();
      if (!(await this.cuentaPuedeUsarEnlace(cuenta, copropiedadId))) {
        return null;
      }

      const token = randomBytes(32).toString('hex');
      await this.enlaces.create({
        tokenHash: hashDe(token),
        accountId: new Types.ObjectId(accountId),
        copropiedadId: new Types.ObjectId(copropiedadId),
        destino,
        expiraEn: new Date(Date.now() + vigenciaMs),
      });

      const url = new URL('/auth/enlace', frontendUrl);
      url.searchParams.set('token', token);
      return url.toString();
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo generar el enlace de acceso: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Turns a token into a Firebase custom token without consuming it: the link
   * stays reusable until it expires, which is the point of an email link.
   */
  async canjear(token: string): Promise<{
    customToken: string;
    copropiedadId: string;
    destino: string;
  } | null> {
    try {
      const enlace = await this.enlaces
        .findOne({ tokenHash: hashDe(token), expiraEn: { $gt: new Date() } })
        .exec();
      if (!enlace) return null;

      const cuenta = await this.cuentas.findById(enlace.accountId).exec();
      const copropiedadId = enlace.copropiedadId.toString();
      if (
        !cuenta ||
        !(await this.cuentaPuedeUsarEnlace(cuenta, copropiedadId))
      ) {
        return null;
      }

      return {
        customToken: await this.auth.createCustomToken(cuenta.firebaseUid),
        copropiedadId,
        destino: enlace.destino,
      };
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo canjear el enlace de acceso: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

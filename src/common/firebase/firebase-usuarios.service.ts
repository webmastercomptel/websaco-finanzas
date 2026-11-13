// src/common/firebase/firebase-usuarios.service.ts
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Auth } from 'firebase-admin/auth';
import { FIREBASE_AUTH } from './firebase.constants';
import { UID_RESIDENTE_REGEX } from './uid-residente';

/**
 * The ONE deliberate exception to "this project only ever verifies
 * identities" (see FirebaseAuthGuard and CLAUDE.md). The Usuarios screen is
 * the platform administrator's own console for provisioning staff, and the
 * legacy system this replaces did exactly this — created the login and the
 * local access record in the same step, rather than sending someone to a
 * separate Firebase console.
 *
 * The exception is kept as narrow as the job requires: create an identity
 * (with a password for staff, uid-only for residents who enter by link), and
 * enable/disable/set a password. Nothing else. In particular there is no
 * `eliminar()` and there must never be one — the same audit law that forbids deleting a financial document
 * forbids deleting an identity. A person is retired by disabling them, never
 * by removing the record of who they were.
 *
 * If you find yourself reaching for `listUsers()`, `getUserByEmail()`, or
 * custom claims here, stop: none of that belongs to Finanzas. Authorization
 * lives entirely in Account/Asignacion — Firebase is asked for nothing beyond
 * "let this address sign in" and "stop letting it".
 */
@Injectable()
export class FirebaseUsuariosService {
  private readonly logger = new Logger(FirebaseUsuariosService.name);

  constructor(@Inject(FIREBASE_AUTH) private readonly auth: Auth) {}

  /**
   * Provisions a sign-in identity for a new user.
   *
   * `emailVerified: true` is deliberate: unlike a public sign-up, this address
   * was typed by an administrator who is vouching for it, not claimed by a
   * stranger. There is no verification flow to route it through.
   */
  async crear(datos: {
    email: string;
    password: string;
    nombre: string;
  }): Promise<{ uid: string }> {
    try {
      const registro = await this.auth.createUser({
        email: datos.email,
        password: datos.password,
        displayName: datos.nombre,
        emailVerified: true,
      });
      return { uid: registro.uid };
    } catch (err) {
      if ((err as { code?: string }).code === 'auth/email-already-exists') {
        // Deliberately does not fall back to reusing the existing identity:
        // that would hand Finanzas access to whoever already owns that
        // address without their part in the decision. An administrator who
        // means to grant the same person access has to say so explicitly by
        // choosing a different resolution — this is not it.
        throw new ConflictException(
          'Ya existe una cuenta de Firebase con ese correo.',
        );
      }
      throw err;
    }
  }

  /**
   * Provisions the sign-in identity of a resident who enters by e-mail link:
   * an identity with a uid and NOTHING else (no e-mail, no password, no display
   * name). It cannot sign in by itself; the only way in is a custom token the
   * backend mints for that uid after the person proved their address.
   *
   * Idempotent on purpose: the uid is derived from the address, so
   * `auth/uid-already-exists` normally means a concurrent redeem or a retry
   * after a crash between Firebase and Mongo already made it, and reusing it is
   * right. But it is not accepted blindly: the existing identity is read (by
   * uid, never by e-mail) and reused only when it is as EMPTY as the one this
   * method creates (no e-mail, no password, no provider). Anything else (an
   * identity someone shaped by hand, or a pool shared with another system) is
   * refused, which the redeem turns into its one opaque 401; the log line names
   * no uid or address. `passwordHash` is usually absent from `getUser`; a
   * password still shows up as a `password` entry in `providerData`.
   * Never looks anyone up by e-mail, and refuses any uid that is not the
   * `rc1_` + SHA-256 shape, so this method cannot create an arbitrary
   * identity (it is not a general-purpose `createUser`).
   */
  async crearIdentidadResidente(uid: string): Promise<void> {
    if (!UID_RESIDENTE_REGEX.test(uid)) {
      throw new Error('Identificador de residente inválido');
    }
    try {
      await this.auth.createUser({ uid });
    } catch (err) {
      if ((err as { code?: string }).code !== 'auth/uid-already-exists') {
        throw err;
      }
      const existente = await this.auth.getUser(uid);
      const vacia =
        !existente.email &&
        !existente.passwordHash &&
        (existente.providerData ?? []).length === 0;
      if (!vacia) {
        this.logger.warn(
          'Identidad de residente ya existente y no vacía: se rechaza (motivo=identidad-ocupada).',
        );
        throw new Error('Identidad de residente no utilizable');
      }
    }
  }

  /**
   * Enables or disables the sign-in identity.
   *
   * This is what makes deactivating a user in Usuarios an immediate lockout
   * rather than a courtesy that waits for a token to expire: `disabled` is
   * checked by `verifyIdToken(token, true)` — the same `checkRevoked` flag
   * FirebaseAuthGuard already passes — the moment the next request arrives.
   * No separate `revokeRefreshTokens()` call is needed; the two failure modes
   * are surfaced by that single flag.
   */
  async establecerHabilitado(uid: string, habilitado: boolean): Promise<void> {
    await this.auth.updateUser(uid, { disabled: !habilitado });
  }

  /**
   * Sets a new password on an existing identity, for a platform administrator
   * resetting one on someone's behalf.
   */
  async actualizarPassword(uid: string, password: string): Promise<void> {
    await this.auth.updateUser(uid, { password });
  }
}

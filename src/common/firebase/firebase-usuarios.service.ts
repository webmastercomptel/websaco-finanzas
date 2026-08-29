// src/common/firebase/firebase-usuarios.service.ts
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Auth } from 'firebase-admin/auth';
import { FIREBASE_AUTH } from './firebase.constants';

/**
 * The ONE deliberate exception to "this project only ever verifies
 * identities" (see FirebaseAuthGuard and AGENTS.md). The Usuarios screen is
 * the platform administrator's own console for provisioning staff, and the
 * legacy system this replaces did exactly this — created the login and the
 * local access record in the same step, rather than sending someone to a
 * separate Firebase console.
 *
 * The exception is kept as narrow as the job requires: two operations,
 * nothing else. In particular there is no `eliminar()` and there must never
 * be one — the same audit law that forbids deleting a financial document
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
          `Ya existe una cuenta de Firebase con el correo ${datos.email}.`,
        );
      }
      throw err;
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

// src/common/guards/firebase-auth.guard.ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import { ClsService } from 'nestjs-cls';
import { FIREBASE_AUTH } from '../firebase/firebase.constants';
import {
  ACTIVE_COPROPERTY_KEY,
  COPROPERTY_HEADER,
} from '../tenant/tenant-context.constants';
import { AccesoService } from '../acceso/acceso.service';
import { CuentaService } from '../cuentas/cuenta.service';
import type { IRequestUser } from '../interfaces/request-user.interface';

interface AuthenticatedRequest extends Request {
  user?: IRequestUser;
}

/**
 * Verifies the `Authorization: Bearer <firebase-id-token>` header, resolves the
 * caller against this system's own accounts, and publishes the active
 * coproperty into CLS so TenantContextService can scope every query for the
 * rest of the request.
 *
 * Applied per controller together with PoliciesGuard, in that order:
 * `@UseGuards(FirebaseAuthGuard, PoliciesGuard)`. PoliciesGuard reads
 * `request.user`, so it can only run after this one.
 *
 * Verification uses `checkRevoked: true`. That costs one extra round trip to
 * the Auth backend per request, and buys immediate revocation: disabling an
 * account in the Firebase console locks it out now, rather than whenever its
 * token happens to expire up to an hour later. For a system that moves money,
 * that trade is not close.
 *
 * Two identities are involved and they are not the same thing. The provider
 * answers "is this person who they claim to be". This system answers "and what
 * may they do here" — a valid token with no local account means authenticated
 * and entitled to nothing.
 */
@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(FirebaseAuthGuard.name);

  constructor(
    @Inject(FIREBASE_AUTH) private readonly auth: Auth,
    private readonly cls: ClsService,
    private readonly cuentas: CuentaService,
    private readonly acceso: AccesoService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.bearerTokenOf(request);

    if (!token) {
      throw new UnauthorizedException('Falta el token de autenticación');
    }

    const decoded = await this.verify(token);
    const cuenta = await this.cuentas.resolverPorToken(
      decoded.uid,
      decoded.email ?? '',
    );

    // No local record: authenticated, and that is all. Not an error — the app
    // needs to render "you have no access here", which it cannot do if the
    // request is rejected outright.
    if (!cuenta) {
      request.user = this.sinAcceso(decoded);
      return true;
    }

    if (cuenta.status !== 'active') {
      // Distinct from "no account": somebody deliberately switched this person
      // off, and they should be told rather than shown an empty app.
      throw new ForbiddenException('Tu cuenta está desactivada');
    }

    request.user = await this.construirUsuario(decoded, cuenta, request);

    if (request.user.coPropertyId) {
      this.cls.set(ACTIVE_COPROPERTY_KEY, request.user.coPropertyId);
    }
    return true;
  }

  /** Extracts the bearer token, tolerating extra whitespace and casing. */
  private bearerTokenOf(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) return undefined;
    const [scheme, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== 'bearer') return undefined;
    return rest.join('') || undefined;
  }

  /**
   * Verifies the token. Every failure mode collapses into one opaque 401: the
   * caller learns that they are not authenticated, never why, so a probe cannot
   * tell an expired token from a revoked one from a forged one. The detail goes
   * to the log instead, where it is useful and not exploitable.
   */
  private async verify(token: string): Promise<DecodedIdToken> {
    try {
      return await this.auth.verifyIdToken(token, true);
    } catch (err) {
      this.logger.warn(`Token rechazado: ${(err as Error).message}`);
      throw new UnauthorizedException('Token de autenticación inválido');
    }
  }

  /** A verified identity with no standing in this system. */
  private sinAcceso(decoded: DecodedIdToken): IRequestUser {
    const email = decoded.email?.trim().toLowerCase() ?? '';
    this.logger.debug(
      `Sin cuenta local para "${email}". Autenticado, sin acceso a nada.`,
    );
    return { uid: decoded.uid, email, permissions: [] };
  }

  /**
   * Assembles the request identity, including which coproperty it acts on.
   *
   * The `X-CoProperty-Id` header is a REQUEST, never a grant. It is re-checked
   * against the caller's live assignments on every call, so a choice the
   * browser remembered — in storage, in a URL, in a tab left open since
   * yesterday — stops working the moment the assignment behind it is revoked.
   *
   * A header naming a coproperty the caller may not use is rejected outright
   * rather than ignored. Silently serving a different tenant's data because the
   * requested one was not allowed is the worst possible answer.
   */
  private async construirUsuario(
    decoded: DecodedIdToken,
    cuenta: {
      _id: unknown;
      email: string;
      fullName: string;
      isPlatformAdmin: boolean;
    },
    request: Request,
  ): Promise<IRequestUser> {
    const accountId = String(cuenta._id);
    const base: IRequestUser = {
      uid: decoded.uid,
      email: cuenta.email,
      accountId,
      nombre: cuenta.fullName,
      isPlatformAdmin: cuenta.isPlatformAdmin,
      permissions: [],
    };

    const header = request.headers[COPROPERTY_HEADER];
    const solicitada = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!solicitada) return base;

    const acceso = await this.acceso.accesoA(
      accountId,
      solicitada,
      cuenta.isPlatformAdmin,
    );
    if (!acceso) {
      this.logger.warn(
        `Cuenta ${cuenta.email} pidió la copropiedad ${solicitada} sin tenerla asignada.`,
      );
      throw new ForbiddenException('No tenés acceso a esta copropiedad');
    }

    return {
      ...base,
      coPropertyId: acceso.coPropertyId,
      permissions: acceso.permissions,
    };
  }
}

import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { Auth, DecodedIdToken } from 'firebase-admin/auth';
import type { ClsService } from 'nestjs-cls';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { ACTIVE_COPROPERTY_KEY } from '../tenant/tenant-context.constants';
import type {
  AccesoService,
  AccesoCopropiedad,
} from '../acceso/acceso.service';
import type { CuentaService } from '../cuentas/cuenta.service';
import type { IRequestUser } from '../interfaces/request-user.interface';

const EMAIL = 'santiago@comptel.com';

const decodedToken = (over: Partial<DecodedIdToken> = {}): DecodedIdToken =>
  ({
    uid: 'uid-123',
    email: EMAIL,
    email_verified: true,
    ...over,
  }) as DecodedIdToken;

const cuentaActiva = {
  _id: 'acc-1',
  email: EMAIL,
  fullName: 'Santiago',
  isPlatformAdmin: false,
  status: 'active',
};

const acceso = (over: Partial<AccesoCopropiedad> = {}): AccesoCopropiedad => ({
  coPropertyId: 'cop-1',
  codigo: 'COP-001',
  nombre: 'Terrazas',
  permissions: ['facturas.ver'],
  ...over,
});

type Harness = {
  guard: FirebaseAuthGuard;
  request: { headers: Record<string, string>; user?: IRequestUser };
  context: ExecutionContext;
  cls: Record<string, unknown>;
  verifyIdToken: jest.Mock;
  accesoA: jest.Mock;
};

const harness = (
  opts: {
    headers?: Record<string, string>;
    verify?: jest.Mock;
    cuenta?: Record<string, unknown> | null;
    acceso?: AccesoCopropiedad | null;
  } = {},
): Harness => {
  const verifyIdToken =
    opts.verify ?? jest.fn().mockResolvedValue(decodedToken());
  const auth = { verifyIdToken } as unknown as Auth;

  const store: Record<string, unknown> = {};
  const cls = {
    set: (key: string, value: unknown) => {
      store[key] = value;
    },
  } as unknown as ClsService;

  const cuentas = {
    resolverPorToken: jest
      .fn()
      .mockResolvedValue(
        opts.cuenta === undefined ? cuentaActiva : opts.cuenta,
      ),
  } as unknown as CuentaService;

  const accesoA = jest
    .fn()
    .mockResolvedValue(opts.acceso === undefined ? acceso() : opts.acceso);
  const accesoService = { accesoA } as unknown as AccesoService;

  const request = { headers: opts.headers ?? {} } as Harness['request'];
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return {
    guard: new FirebaseAuthGuard(auth, cls, cuentas, accesoService),
    request,
    context,
    cls: store,
    verifyIdToken,
    accesoA,
  };
};

const bearer = (token = 'token-valido') => ({
  authorization: `Bearer ${token}`,
});

describe('FirebaseAuthGuard — token', () => {
  it('rechaza una petición sin cabecera Authorization', async () => {
    const { guard, context } = harness();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza un esquema que no sea Bearer', async () => {
    const { guard, context } = harness({
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('acepta "bearer" en minúscula y con espacios de más', async () => {
    const { guard, context, verifyIdToken } = harness({
      headers: { authorization: '  bearer   token-valido  ' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verifyIdToken).toHaveBeenCalledWith('token-valido', true);
  });

  it('verifica comprobando revocación', async () => {
    const { guard, context, verifyIdToken } = harness({ headers: bearer() });

    await guard.canActivate(context);

    // El segundo argumento es checkRevoked: deshabilitar la cuenta en la
    // consola tiene que cortar el acceso ya, no cuando expire el token.
    expect(verifyIdToken).toHaveBeenCalledWith('token-valido', true);
  });

  it('no filtra el motivo del rechazo al cliente', async () => {
    const verify = jest
      .fn()
      .mockRejectedValue(new Error('auth/id-token-revoked'));
    const { guard, context } = harness({ headers: bearer(), verify });

    await expect(guard.canActivate(context)).rejects.toThrow(
      'Token de autenticación inválido',
    );
  });
});

describe('FirebaseAuthGuard — cuenta local', () => {
  it('un token válido sin cuenta local entra sin acceso a nada', async () => {
    // No es un error: la app necesita poder mostrar "no tenés acceso", y no
    // podría si se rechazara la petición.
    const { guard, context, request } = harness({
      headers: bearer(),
      cuenta: null,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user?.accountId).toBeUndefined();
    expect(request.user?.permissions).toEqual([]);
  });

  it('rechaza una cuenta desactivada, distinto de no tener cuenta', async () => {
    // Alguien la apagó a propósito; corresponde decírselo, no mostrarle una
    // aplicación vacía.
    const { guard, context } = harness({
      headers: bearer(),
      cuenta: { ...cuentaActiva, status: 'inactive' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('toma nombre y condición de admin de la cuenta local, no del token', async () => {
    // El proveedor dice quién sos; este sistema dice qué podés hacer.
    const { guard, context, request } = harness({
      headers: bearer(),
      cuenta: {
        ...cuentaActiva,
        fullName: 'Otro Nombre',
        isPlatformAdmin: true,
      },
    });

    await guard.canActivate(context);

    expect(request.user?.nombre).toBe('Otro Nombre');
    expect(request.user?.isPlatformAdmin).toBe(true);
  });
});

describe('FirebaseAuthGuard — copropiedad activa', () => {
  it('sin header no activa ninguna copropiedad', async () => {
    const { guard, context, request, cls, accesoA } = harness({
      headers: bearer(),
    });

    await guard.canActivate(context);

    expect(request.user?.coPropertyId).toBeUndefined();
    expect(cls[ACTIVE_COPROPERTY_KEY]).toBeUndefined();
    expect(accesoA).not.toHaveBeenCalled();
  });

  it('activa la copropiedad pedida cuando está asignada', async () => {
    const { guard, context, request, cls } = harness({
      headers: { ...bearer(), 'x-coproperty-id': 'cop-1' },
    });

    await guard.canActivate(context);

    expect(request.user?.coPropertyId).toBe('cop-1');
    expect(cls[ACTIVE_COPROPERTY_KEY]).toBe('cop-1');
  });

  it('trae los permisos de ESA copropiedad', async () => {
    const { guard, context, request } = harness({
      headers: { ...bearer(), 'x-coproperty-id': 'cop-1' },
      acceso: acceso({ permissions: ['facturas.anular'] }),
    });

    await guard.canActivate(context);

    expect(request.user?.permissions).toEqual(['facturas.anular']);
  });

  it('RECHAZA una copropiedad que el llamante no tiene asignada', async () => {
    // Servir en silencio otra copropiedad porque la pedida no estaba permitida
    // sería la peor respuesta posible.
    const { guard, context } = harness({
      headers: { ...bearer(), 'x-coproperty-id': 'cop-ajena' },
      acceso: null,
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('revalida el header en cada petición', async () => {
    // Lo que el navegador recuerda es un PEDIDO, no un permiso: una asignación
    // revocada hace un minuto tiene que dejar de funcionar ahora.
    const { guard, context, accesoA } = harness({
      headers: { ...bearer(), 'x-coproperty-id': 'cop-1' },
    });

    await guard.canActivate(context);
    await guard.canActivate(context);

    expect(accesoA).toHaveBeenCalledTimes(2);
  });

  it('ignora un header vacío en lugar de consultarlo', async () => {
    const { guard, context, accesoA } = harness({
      headers: { ...bearer(), 'x-coproperty-id': '   ' },
    });

    await guard.canActivate(context);

    expect(accesoA).not.toHaveBeenCalled();
  });
});

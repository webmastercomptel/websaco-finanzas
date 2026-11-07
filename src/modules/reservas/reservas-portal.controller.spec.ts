import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
  MODULO_KEY,
} from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { ReservasPortalController } from './reservas-portal.controller';

const handlers = (): Array<[string, object]> =>
  Object.getOwnPropertyNames(ReservasPortalController.prototype)
    .filter((n) => n !== 'constructor')
    .map((n): [string, object] => [
      n,
      (ReservasPortalController.prototype as unknown as Record<string, object>)[
        n
      ],
    ])
    .filter(([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined);

describe('ReservasPortalController — metadatos de acceso', () => {
  it('cuelga de portal/reservas', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReservasPortalController)).toBe(
      'portal/reservas',
    );
  });

  it('usa PortalGuard después de FirebaseAuthGuard (PortalGuard lee request.user)', () => {
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, ReservasPortalController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);

    expect(guards).toEqual(['FirebaseAuthGuard', 'PortalGuard']);
  });

  it('declara el módulo administracion', () => {
    expect(Reflect.getMetadata(MODULO_KEY, ReservasPortalController)).toBe(
      'administracion',
    );
  });

  it('ninguna ruta del residente pasa por CASL: los residentes no tienen permisos', () => {
    for (const [, fn] of handlers()) {
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, fn)).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(CHECK_ABILITY_KEY, ReservasPortalController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, ReservasPortalController),
    ).toBeUndefined();
  });

  it('expone exactamente lo que el residente podía hacer: ver ocupación, listar las suyas, pedir y cancelar. Ni aprobar, ni rechazar, ni "todas", ni cola, ni stats', () => {
    expect(
      handlers()
        .map(([nombre, fn]) => [
          nombre,
          String(Reflect.getMetadata(PATH_METADATA, fn)),
        ])
        .sort(),
    ).toEqual([
      ['cancelar', ':id/cancelar'],
      ['crear', '/'],
      ['disponibilidad', ':espacioId/disponibilidad'],
      ['listar', '/'],
    ]);
  });
});

describe('ReservasPortalController — el PortalGuard real', () => {
  const guard = new PortalGuard(new Reflector());

  const contexto = (user: Partial<IRequestUser>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      // Only the function object is read for its metadata; it is never called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => ReservasPortalController.prototype.listar,
      getClass: () => ReservasPortalController,
    }) as unknown as ExecutionContext;

  const base: IRequestUser = {
    uid: 'u',
    email: 'r@x.co',
    accountId: 'cuenta-1',
    copropiedadId: 'cop-1',
    esResidente: true,
    modulos: ['administracion'],
  };

  it('deja pasar a quien tiene una unidad en la copropiedad activa con el módulo contratado', () => {
    expect(guard.canActivate(contexto(base))).toBe(true);
  });

  it('niega a quien no es residente de la copropiedad activa', () => {
    expect(() =>
      guard.canActivate(contexto({ ...base, esResidente: false })),
    ).toThrow(ForbiddenException);
  });

  it('niega si la copropiedad no contrató el módulo administracion', () => {
    expect(() =>
      guard.canActivate(contexto({ ...base, modulos: ['finanzas'] })),
    ).toThrow(ForbiddenException);
  });
});

describe('ReservasPortalController — delegación', () => {
  const user: IRequestUser = { uid: 'u', email: 'r@x.co', accountId: 'c1' };

  it('cada ruta llega al servicio por el método "propio"/"residente", con el usuario', async () => {
    const servicio = {
      listarPropias: jest.fn().mockResolvedValue([]),
      crearComoResidente: jest.fn().mockResolvedValue({}),
      cancelarPropia: jest.fn().mockResolvedValue({}),
      disponibilidad: jest.fn().mockResolvedValue({}),
    };
    const controlador = new ReservasPortalController(servicio as never);
    const dto = {
      espacioId: 'e',
      inicio: '2026-09-01T10:00:00Z',
      fin: '2026-09-01T11:00:00Z',
    };

    await controlador.listar(user);
    await controlador.crear(dto, user);
    await controlador.cancelar('r1', user);
    await controlador.disponibilidad('e1', { fecha: '2026-09-01' });

    expect(servicio.listarPropias).toHaveBeenCalledWith(user);
    expect(servicio.crearComoResidente).toHaveBeenCalledWith(dto, user);
    expect(servicio.cancelarPropia).toHaveBeenCalledWith('r1', user);
    expect(servicio.disponibilidad).toHaveBeenCalledWith('e1', '2026-09-01');
  });
});

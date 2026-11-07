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
import { PqrPortalController } from './pqr-portal.controller';

const handlers = (): Array<[string, object]> =>
  Object.getOwnPropertyNames(PqrPortalController.prototype)
    .filter((n) => n !== 'constructor')
    .map((n): [string, object] => [
      n,
      (PqrPortalController.prototype as unknown as Record<string, object>)[n],
    ])
    .filter(([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined);

describe('PqrPortalController — metadatos de acceso', () => {
  it('cuelga de portal/pqr', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PqrPortalController)).toBe(
      'portal/pqr',
    );
  });

  it('usa PortalGuard después de FirebaseAuthGuard (PortalGuard lee request.user)', () => {
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, PqrPortalController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);

    expect(guards).toEqual(['FirebaseAuthGuard', 'PortalGuard']);
  });

  it('declara el módulo administracion', () => {
    expect(Reflect.getMetadata(MODULO_KEY, PqrPortalController)).toBe(
      'administracion',
    );
  });

  it('ninguna ruta del residente pasa por CASL: los residentes no tienen permisos', () => {
    for (const [, fn] of handlers()) {
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, fn)).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(CHECK_ABILITY_KEY, PqrPortalController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, PqrPortalController),
    ).toBeUndefined();
  });

  it('expone exactamente lo que el residente podía hacer: crear, listar, ver, responder y adjuntar. Ni estado, ni asignación, ni "todas"', () => {
    expect(
      handlers()
        .map(([nombre, fn]) => [
          nombre,
          String(Reflect.getMetadata(PATH_METADATA, fn)),
        ])
        .sort(),
    ).toEqual([
      ['confirmarAdjunto', ':id/adjuntos/:attachmentId/confirmar'],
      ['crear', '/'],
      ['iniciarAdjunto', ':id/adjuntos'],
      ['listar', '/'],
      ['obtener', ':id'],
      ['responder', ':id/seguimientos'],
    ]);
  });
});

describe('PqrPortalController — el PortalGuard real', () => {
  const guard = new PortalGuard(new Reflector());

  const contexto = (user: Partial<IRequestUser>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      // Only the function object is read for its metadata; it is never called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => PqrPortalController.prototype.listar,
      getClass: () => PqrPortalController,
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

describe('PqrPortalController — delegación', () => {
  const user: IRequestUser = {
    uid: 'u',
    email: 'r@x.co',
    accountId: 'cuenta-1',
    nombre: 'Juan',
  };

  function montar() {
    const pqr = {
      crearComoResidente: jest.fn().mockResolvedValue({ id: 'p1' }),
      listarPropias: jest.fn().mockResolvedValue([]),
      obtenerPropia: jest.fn().mockResolvedValue({ id: 'p1' }),
      responderPropia: jest.fn().mockResolvedValue({ id: 'p1' }),
    };
    const adjuntos = {
      iniciarSubidaResidente: jest.fn().mockResolvedValue({}),
      confirmarSubidaResidente: jest.fn().mockResolvedValue({}),
    };
    return {
      pqr,
      adjuntos,
      controlador: new PqrPortalController(pqr as never, adjuntos as never),
    };
  }

  it('todas las operaciones propias reciben al usuario autenticado, nunca un id de autor del cliente', async () => {
    const { pqr, adjuntos, controlador } = montar();
    const dto = {
      nombre: 'a.pdf',
      mimeType: 'application/pdf',
      tamanoBytes: 1,
    };

    await controlador.crear(
      { titulo: 'T', descripcion: 'D', tipo: 'quejas', unidad: 'A-1' },
      user,
    );
    await controlador.listar({ estado: 'pendiente' }, user);
    await controlador.obtener('p1', user);
    await controlador.responder('p1', { mensaje: 'Hola' }, user);
    await controlador.iniciarAdjunto('p1', dto, user);
    await controlador.confirmarAdjunto('p1', 'a1', user);

    expect(pqr.crearComoResidente).toHaveBeenCalledWith(
      { titulo: 'T', descripcion: 'D', tipo: 'quejas', unidad: 'A-1' },
      user,
    );
    expect(pqr.listarPropias).toHaveBeenCalledWith(
      { estado: 'pendiente' },
      user,
    );
    expect(pqr.obtenerPropia).toHaveBeenCalledWith('p1', user);
    expect(pqr.responderPropia).toHaveBeenCalledWith(
      'p1',
      { mensaje: 'Hola' },
      user,
    );
    expect(adjuntos.iniciarSubidaResidente).toHaveBeenCalledWith(
      'p1',
      dto,
      user,
    );
    expect(adjuntos.confirmarSubidaResidente).toHaveBeenCalledWith(
      'p1',
      'a1',
      user,
    );
  });
});

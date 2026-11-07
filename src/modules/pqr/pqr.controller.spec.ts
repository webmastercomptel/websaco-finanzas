import 'reflect-metadata';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { PoliciesGuard } from '../casl/policies.guard';
import { PqrController } from './pqr.controller';

/** The ability a handler declares, read from the same metadata the guard reads. */
const reglasDe = (handler: keyof PqrController): RequiredRule[] =>
  Reflect.getMetadata(
    CHECK_ABILITY_KEY,
    // Only the function object is read for its metadata; it is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    PqrController.prototype[handler],
  ) as RequiredRule[];

describe('PqrController — política de acceso', () => {
  it('cuelga de pqrs (la ruta del sistema original)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PqrController)).toBe('pqrs');
  });

  // Decisión de seguridad: ver (read) no basta para tocar nada.
  it.each([
    ['listar', 'read'],
    ['obtener', 'read'],
    ['crear', 'manage'],
    ['actualizar', 'manage'],
    ['responder', 'manage'],
    ['iniciarAdjunto', 'manage'],
    ['confirmarAdjunto', 'manage'],
    ['descargarAdjunto', 'read'],
  ] as const)('%s exige la acción %s sobre Pqr', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Pqr' }]);
  });

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, PqrController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, PqrController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });
});

describe('PqrController — el PoliciesGuard real sobre las rutas reales', () => {
  const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

  const contexto = (
    handler: keyof PqrController,
    permissions: string[],
  ): ExecutionContext => {
    const user: IRequestUser = {
      uid: 'u',
      email: 'a@b.co',
      permissions,
      modulos: ['administracion'],
    };
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
      // Only the function object is read for its metadata; it is never called.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      getHandler: () => PqrController.prototype[handler],
      getClass: () => PqrController,
    } as unknown as ExecutionContext;
  };

  const lecturas = ['listar', 'obtener', 'descargarAdjunto'] as const;
  const escrituras = [
    'crear',
    'actualizar',
    'responder',
    'iniciarAdjunto',
    'confirmarAdjunto',
  ] as const;

  it.each(lecturas)('pqr.ver permite %s', (handler) => {
    expect(guard.canActivate(contexto(handler, ['pqr.ver']))).toBe(true);
  });

  it.each(escrituras)('pqr.ver NO permite %s', (handler) => {
    expect(() => guard.canActivate(contexto(handler, ['pqr.ver']))).toThrow(
      ForbiddenException,
    );
  });

  it.each([...lecturas, ...escrituras])(
    'pqr.gestionar permite %s',
    (handler) => {
      expect(guard.canActivate(contexto(handler, ['pqr.gestionar']))).toBe(
        true,
      );
    },
  );

  it.each([...lecturas, ...escrituras])(
    'un residente sin permisos no entra a %s',
    (handler) => {
      expect(() => guard.canActivate(contexto(handler, []))).toThrow(
        ForbiddenException,
      );
    },
  );

  it('tecnicos.gestionar no da acceso a las PQR', () => {
    expect(() =>
      guard.canActivate(contexto('listar', ['tecnicos.gestionar'])),
    ).toThrow(ForbiddenException);
  });
});

describe('PqrController — delegación', () => {
  const user: IRequestUser = {
    uid: 'u',
    email: 'a@b.co',
    accountId: 'cuenta-1',
    nombre: 'Ana',
  };

  function montar() {
    const pqr = {
      listar: jest.fn().mockResolvedValue([]),
      obtener: jest.fn().mockResolvedValue({ id: 'p1' }),
      crear: jest.fn().mockResolvedValue({ id: 'p1' }),
      actualizar: jest.fn().mockResolvedValue({ id: 'p1' }),
      responder: jest.fn().mockResolvedValue({ id: 'p1' }),
    };
    const adjuntos = {
      iniciarSubida: jest.fn().mockResolvedValue({}),
      confirmarSubida: jest.fn().mockResolvedValue({}),
    };
    return {
      pqr,
      adjuntos,
      controlador: new PqrController(pqr as never, adjuntos as never),
    };
  }

  it('pasa los filtros al listar y el id al obtener', async () => {
    const { pqr, controlador } = montar();

    await controlador.listar({ tipo: 'quejas' });
    await controlador.obtener('p1');

    expect(pqr.listar).toHaveBeenCalledWith({ tipo: 'quejas' });
    expect(pqr.obtener).toHaveBeenCalledWith('p1');
  });

  it('delega crear, actualizar y responder con id, cuerpo y usuario', async () => {
    const { pqr, controlador } = montar();

    await controlador.crear(
      { titulo: 'T', descripcion: 'D', tipo: 'quejas' },
      user,
    );
    await controlador.actualizar('p1', { estado: 'resuelto' });
    await controlador.responder('p1', { mensaje: 'Hola' }, user);

    expect(pqr.crear).toHaveBeenCalledWith(
      { titulo: 'T', descripcion: 'D', tipo: 'quejas' },
      user,
    );
    expect(pqr.actualizar).toHaveBeenCalledWith('p1', { estado: 'resuelto' });
    expect(pqr.responder).toHaveBeenCalledWith('p1', { mensaje: 'Hola' }, user);
  });

  it('delega los dos pasos del adjunto', async () => {
    const { adjuntos, controlador } = montar();
    const dto = {
      nombre: 'a.pdf',
      mimeType: 'application/pdf',
      tamanoBytes: 1,
    };

    await controlador.iniciarAdjunto('p1', dto);
    await controlador.confirmarAdjunto('p1', 'a1');

    expect(adjuntos.iniciarSubida).toHaveBeenCalledWith('p1', dto);
    expect(adjuntos.confirmarSubida).toHaveBeenCalledWith('p1', 'a1');
  });
});

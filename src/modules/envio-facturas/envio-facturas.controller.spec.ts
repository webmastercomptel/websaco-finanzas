import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import { PoliciesGuard } from '../casl/policies.guard';
import { EnvioFacturasController } from './envio-facturas.controller';

/** The handler by name, typed so reading it off the prototype is not an unbound method. */
const handlerDe = (nombre: keyof EnvioFacturasController): (() => unknown) =>
  (
    EnvioFacturasController.prototype as unknown as Record<
      string,
      () => unknown
    >
  )[nombre];

const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

/** Context for one real handler of the real controller, with this caller. */
const contexto = (
  handler: keyof EnvioFacturasController,
  user: IRequestUser,
): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handlerDe(handler),
    getClass: () => EnvioFacturasController,
  }) as unknown as ExecutionContext;

const usuario = (
  permissions: string[],
  over: Partial<IRequestUser> = {},
): IRequestUser => ({
  uid: 'uid-1',
  email: 'ana@ejemplo.com',
  accountId: 'acc-1',
  copropiedadId: 'cop-1',
  modulos: ['finanzas'],
  permissions,
  ...over,
});

describe('EnvioFacturasController — autorización', () => {
  it('pasa por FirebaseAuthGuard y luego PoliciesGuard', () => {
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, EnvioFacturasController) as {
        name: string;
      }[]
    ).map((g) => g.name);

    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it.each(['marcar', 'procesarPendientes'] as const)(
    '%s exige facturas.aprobar: sin él, 403',
    (ruta) => {
      for (const permisos of [
        [],
        ['facturas.ver'],
        ['facturas.crear', 'facturas.editar'],
      ]) {
        expect(() =>
          guard.canActivate(contexto(ruta, usuario(permisos))),
        ).toThrow(ForbiddenException);
      }
      expect(
        guard.canActivate(contexto(ruta, usuario(['facturas.aprobar']))),
      ).toBe(true);
    },
  );

  it.each(['listar', 'resumen'] as const)(
    '%s se abre con facturas.ver pero no sin permisos',
    (ruta) => {
      expect(guard.canActivate(contexto(ruta, usuario(['facturas.ver'])))).toBe(
        true,
      );
      expect(() => guard.canActivate(contexto(ruta, usuario([])))).toThrow(
        ForbiddenException,
      );
    },
  );

  it.each(['listar', 'resumen', 'marcar', 'procesarPendientes'] as const)(
    '%s con el módulo de Finanzas apagado responde 403 aunque tenga el permiso',
    (ruta) => {
      const permisos = ['facturas.ver', 'facturas.aprobar'];

      expect(() =>
        guard.canActivate(
          contexto(ruta, usuario(permisos, { modulos: ['administracion'] })),
        ),
      ).toThrow(ForbiddenException);
      expect(() =>
        guard.canActivate(contexto(ruta, usuario(permisos, { modulos: [] }))),
      ).toThrow(ForbiddenException);
    },
  );

  it.each(['listar', 'resumen', 'marcar', 'procesarPendientes'] as const)(
    '%s: un residente (propietario o arrendatario) recibe 403',
    (ruta) => {
      expect(() =>
        guard.canActivate(contexto(ruta, usuario([], { esResidente: true }))),
      ).toThrow(ForbiddenException);
    },
  );

  it('una sesión sin usuario no entra', () => {
    expect(() =>
      guard.canActivate({
        switchToHttp: () => ({ getRequest: () => ({}) }),
        getHandler: () => handlerDe('marcar'),
        getClass: () => EnvioFacturasController,
      } as unknown as ExecutionContext),
    ).toThrow(ForbiddenException);
  });

  it('el personal operativo con permisos de Administración no obtiene el envío de facturas', () => {
    const personal = usuario([
      'anuncios.gestionar',
      'documentos-administracion.gestionar',
    ]);

    expect(() => guard.canActivate(contexto('marcar', personal))).toThrow(
      ForbiddenException,
    );
    expect(() =>
      guard.canActivate(contexto('procesarPendientes', personal)),
    ).toThrow(ForbiddenException);
  });
});

describe('EnvioFacturasController — delegación', () => {
  it('cada ruta delega en su servicio con el usuario de la sesión', async () => {
    const envios = {
      listar: jest.fn().mockResolvedValue('lista'),
      resumen: jest.fn().mockResolvedValue('resumen'),
      marcar: jest.fn().mockResolvedValue('marcado'),
    };
    const proceso = {
      procesarPendientes: jest.fn().mockResolvedValue('proceso'),
    };
    const controller = new EnvioFacturasController(
      envios as never,
      proceso as never,
    );
    const user = usuario(['facturas.aprobar']);

    expect(await controller.listar({})).toBe('lista');
    expect(await controller.resumen()).toBe('resumen');
    expect(await controller.marcar({ loteId: 'x' }, user)).toBe('marcado');
    expect(await controller.procesarPendientes(user)).toBe('proceso');
    expect(envios.marcar).toHaveBeenCalledWith({ loteId: 'x' }, user);
    expect(proceso.procesarPendientes).toHaveBeenCalledWith(user);
  });
});

import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InmueblesController } from './inmuebles.controller';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import { PoliciesGuard } from '../casl/policies.guard';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
} from '../casl/check-ability.decorator';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

// The controller imports the report service, which pulls in the PDF renderer
// (not loadable under jest) — the roster PDF is irrelevant here.
jest.mock('../../common/pdf/inmuebles-listado-pdf', () => ({
  generarPdfListadoInmuebles: jest.fn(),
}));

const handler = (): object =>
  Object.getOwnPropertyDescriptor(
    InmueblesController.prototype,
    'exportarImportacion',
  )?.value as object;

const contextoDe = (user: IRequestUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => handler(),
    getClass: () => InmueblesController,
  }) as unknown as ExecutionContext;

const usuarioCon = (permissions: string[]): IRequestUser => ({
  uid: 'uid-1',
  email: 'admin@ejemplo.com',
  permissions,
});

describe('InmueblesController.exportarImportacion', () => {
  it('se sirve en GET exportar-importacion y delega en el servicio', async () => {
    const respuesta = { copropiedadCodigo: '0001', filas: [] };
    const servicio = {
      exportarImportacion: jest.fn().mockResolvedValue(respuesta),
    };
    const controlador = new InmueblesController(
      servicio as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(controlador.exportarImportacion()).resolves.toBe(respuesta);
    expect(Reflect.getMetadata('path', handler())).toBe('exportar-importacion');
    expect(Reflect.getMetadata('method', handler())).toBe(0); // RequestMethod.GET
  });

  it('declara la ruta antes de `:id` para que el parámetro no la trague', () => {
    const metodos = Object.getOwnPropertyNames(InmueblesController.prototype);

    expect(metodos.indexOf('exportarImportacion')).toBeLessThan(
      metodos.indexOf('findOne'),
    );
  });

  it('exige leer Inmueble Y leer Tercero (AND), sin reglas OR', () => {
    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handler())).toEqual([
      { action: 'read', subject: 'Inmueble' },
      { action: 'read', subject: 'Tercero' },
    ]);
    expect(
      Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handler()),
    ).toBeUndefined();
  });

  describe('con el PoliciesGuard real sobre esa ruta', () => {
    const guard = new PoliciesGuard(new Reflector(), new CaslAbilityFactory());

    it('deniega (403) a quien puede ver inmuebles pero no terceros', () => {
      expect(() =>
        guard.canActivate(contextoDe(usuarioCon(['inmuebles.ver']))),
      ).toThrow(ForbiddenException);
    });

    it('deniega (403) a quien puede ver terceros pero no inmuebles', () => {
      expect(() =>
        guard.canActivate(contextoDe(usuarioCon(['terceros.ver']))),
      ).toThrow(ForbiddenException);
    });

    it('permite a quien puede ver inmuebles y terceros', () => {
      expect(
        guard.canActivate(
          contextoDe(usuarioCon(['inmuebles.ver', 'terceros.ver'])),
        ),
      ).toBe(true);
    });
  });
});

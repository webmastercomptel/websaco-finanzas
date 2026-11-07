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
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { PortalGuard } from '../portal/portal.guard';
import { PanelAdministracionPortalController } from './panel-administracion-portal.controller';
import { PanelAdministracionController } from './panel-administracion.controller';
import type { PanelAdministracionService } from './panel-administracion.service';

const guardNames = (controller: object): string[] =>
  (
    Reflect.getMetadata(GUARDS_METADATA, controller) as Array<{ name: string }>
  ).map((g) => g.name);

const handlers = (controller: { prototype: object }): Array<[string, object]> =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter((n) => n !== 'constructor')
    .map((n): [string, object] => [
      n,
      (controller.prototype as Record<string, object>)[n],
    ])
    .filter(([, fn]) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined);

describe('PanelAdministracionController — metadatos de acceso', () => {
  it('cuelga de panel-administracion/resumen', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, PanelAdministracionController),
    ).toBe('panel-administracion');
    expect(
      handlers(PanelAdministracionController).map(([n, fn]) => [
        n,
        String(Reflect.getMetadata(PATH_METADATA, fn)),
      ]),
    ).toEqual([['resumen', 'resumen']]);
  });

  it('exige leer Dashboard (dashboard.ver)', () => {
    const [[, fn]] = handlers(PanelAdministracionController);

    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, fn)).toEqual([
      { action: 'read', subject: 'Dashboard' },
    ] satisfies RequiredRule[]);
  });

  it('usa FirebaseAuthGuard antes que PoliciesGuard (PoliciesGuard lee request.user)', () => {
    expect(guardNames(PanelAdministracionController)).toEqual([
      'FirebaseAuthGuard',
      'PoliciesGuard',
    ]);
  });

  it('declara el módulo administracion: una copropiedad sin licencia recibe 403', () => {
    expect(Reflect.getMetadata(MODULO_KEY, PanelAdministracionController)).toBe(
      'administracion',
    );
  });

  it('delega en el servicio con el usuario y no recibe parámetros de la query', async () => {
    const resumen = { estadisticas: {} };
    const resumenPersonal = jest.fn().mockResolvedValue(resumen);
    const controller = new PanelAdministracionController({
      resumenPersonal,
    } as unknown as PanelAdministracionService);
    const user = { uid: 'u', email: 'a@b.co' } as IRequestUser;

    await expect(controller.resumen(user)).resolves.toBe(resumen);
    expect(resumenPersonal).toHaveBeenCalledWith(user);
  });
});

describe('PanelAdministracionPortalController — metadatos de acceso', () => {
  it('cuelga de portal/panel', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, PanelAdministracionPortalController),
    ).toBe('portal/panel');
  });

  it('usa PortalGuard después de FirebaseAuthGuard (PortalGuard lee request.user)', () => {
    expect(guardNames(PanelAdministracionPortalController)).toEqual([
      'FirebaseAuthGuard',
      'PortalGuard',
    ]);
  });

  it('declara el módulo administracion', () => {
    expect(
      Reflect.getMetadata(MODULO_KEY, PanelAdministracionPortalController),
    ).toBe('administracion');
  });

  it('no pasa por CASL: los residentes no tienen permisos', () => {
    for (const [, fn] of handlers(PanelAdministracionPortalController)) {
      expect(Reflect.getMetadata(CHECK_ABILITY_KEY, fn)).toBeUndefined();
      expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, fn)).toBeUndefined();
    }
    expect(
      Reflect.getMetadata(
        CHECK_ABILITY_KEY,
        PanelAdministracionPortalController,
      ),
    ).toBeUndefined();
  });

  it('expone una única lectura y ninguna escritura', () => {
    expect(
      handlers(PanelAdministracionPortalController).map(([n, fn]) => [
        n,
        Reflect.getMetadata(METHOD_METADATA, fn) as number,
      ]),
    ).toEqual([['resumen', 0]]); // RequestMethod.GET === 0
  });

  it('delega en el resumen del residente con el usuario', async () => {
    const resumen = { estadisticas: {} };
    const resumenResidente = jest.fn().mockResolvedValue(resumen);
    const controller = new PanelAdministracionPortalController({
      resumenResidente,
    } as unknown as PanelAdministracionService);
    const user = { uid: 'u', email: 'a@b.co' } as IRequestUser;

    await expect(controller.resumen(user)).resolves.toBe(resumen);
    expect(resumenResidente).toHaveBeenCalledWith(user);
  });

  describe('PortalGuard', () => {
    const contexto = (user: Partial<IRequestUser>) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
        getHandler: () => handlers(PanelAdministracionPortalController)[0][1],
        getClass: () => PanelAdministracionPortalController,
      }) as unknown as ExecutionContext;

    it('deja pasar a un residente de una copropiedad con el módulo', () => {
      const guard = new PortalGuard(new Reflector());

      expect(
        guard.canActivate(
          contexto({
            esResidente: true,
            copropiedadId: 'c1',
            accountId: 'a1',
            modulos: ['administracion'],
          }),
        ),
      ).toBe(true);
    });

    it('rechaza a quien no es residente aunque tenga permisos de personal', () => {
      const guard = new PortalGuard(new Reflector());

      expect(() =>
        guard.canActivate(
          contexto({
            esResidente: false,
            copropiedadId: 'c1',
            accountId: 'a1',
            permissions: ['dashboard.ver'],
            modulos: ['administracion'],
          }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('rechaza a un residente de una copropiedad sin el módulo administracion', () => {
      const guard = new PortalGuard(new Reflector());

      expect(() =>
        guard.canActivate(
          contexto({
            esResidente: true,
            copropiedadId: 'c1',
            accountId: 'a1',
            modulos: ['finanzas'],
          }),
        ),
      ).toThrow(ForbiddenException);
    });
  });
});

import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { AccesoResidentesController } from './acceso-residentes.controller';

const proto = AccesoResidentesController.prototype as unknown as Record<
  string,
  object
>;
const reglasDe = (handler: keyof AccesoResidentesController): RequiredRule[] =>
  Reflect.getMetadata(CHECK_ABILITY_KEY, proto[handler]) as RequiredRule[];

describe('AccesoResidentesController — política de acceso', () => {
  it('cuelga de residentes, bajo el módulo administracion y con los guards en orden', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AccesoResidentesController)).toBe(
      'residentes',
    );
    expect(Reflect.getMetadata(MODULO_KEY, AccesoResidentesController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(
        GUARDS_METADATA,
        AccesoResidentesController,
      ) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it.each([
    ['listar', 'read'],
    ['aprovisionar', 'create'],
    ['crearAcceso', 'create'],
    ['reenviarInvitacion', 'update'],
    ['desvincular', 'remove'],
  ] as const)('%s exige %s sobre Usuario (usuarios.*)', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Usuario' }]);
  });

  it('expone exactamente las rutas esperadas y aprovisionar va antes que las rutas con :terceroId', () => {
    const rutas = Object.getOwnPropertyNames(
      AccesoResidentesController.prototype,
    )
      .filter((n) => n !== 'constructor')
      .filter(
        (n) => Reflect.getMetadata(METHOD_METADATA, proto[n]) !== undefined,
      )
      .map((n) => [
        n,
        RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[n]) as number],
        String(Reflect.getMetadata(PATH_METADATA, proto[n])),
      ]);

    expect(rutas).toEqual([
      ['listar', 'GET', '/'],
      ['aprovisionar', 'POST', 'aprovisionar'],
      ['crearAcceso', 'POST', ':terceroId/acceso'],
      ['reenviarInvitacion', 'POST', ':terceroId/reenviar-invitacion'],
      ['desvincular', 'DELETE', ':terceroId/acceso'],
    ]);
  });

  it('pasa el usuario autenticado al servicio al crear, aprovisionar y desvincular', async () => {
    const user: IRequestUser = { uid: 'u', email: 'a@b.co', accountId: 'c1' };
    const servicio = {
      listar: jest.fn().mockResolvedValue({}),
      aprovisionar: jest.fn().mockResolvedValue({}),
      crearAcceso: jest.fn().mockResolvedValue({}),
      reenviarInvitacion: jest.fn().mockResolvedValue({}),
      desvincular: jest.fn().mockResolvedValue({}),
    };
    const c = new AccesoResidentesController(servicio as never);

    await c.aprovisionar({ limite: 5 }, user);
    await c.crearAcceso('t1', { vincularExistente: true }, user);
    await c.desvincular('t1', user);
    await c.reenviarInvitacion('t1');

    expect(servicio.aprovisionar).toHaveBeenCalledWith({ limite: 5 }, user);
    expect(servicio.crearAcceso).toHaveBeenCalledWith(
      't1',
      { vincularExistente: true },
      user,
    );
    expect(servicio.desvincular).toHaveBeenCalledWith('t1', user);
    expect(servicio.reenviarInvitacion).toHaveBeenCalledWith('t1');
  });
});

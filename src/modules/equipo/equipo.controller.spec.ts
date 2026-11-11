import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { guardDejaPasar } from '../casl/testing/politica-de-ruta';
import { AccesoResidentesController } from '../acceso-residentes/acceso-residentes.controller';
import { EquipoController } from './equipo.controller';

const proto = EquipoController.prototype as unknown as Record<string, object>;
const reglasDe = (handler: keyof EquipoController): RequiredRule[] =>
  Reflect.getMetadata(CHECK_ABILITY_KEY, proto[handler]) as RequiredRule[];

describe('EquipoController — política de acceso', () => {
  it('cuelga de equipo, bajo cualquiera de los dos módulos y con los guards en orden', () => {
    expect(Reflect.getMetadata(PATH_METADATA, EquipoController)).toBe('equipo');
    expect(Reflect.getMetadata(MODULO_KEY, EquipoController)).toEqual([
      'finanzas',
      'administracion',
    ]);
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, EquipoController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it.each([
    ['listar', 'read'],
    ['obtener', 'read'],
    ['crear', 'create'],
    ['actualizar', 'update'],
    ['reenviarInvitacion', 'update'],
    ['desactivar', 'remove'],
  ] as const)('%s exige %s sobre Usuario (usuarios.*)', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Usuario' }]);
  });

  it('expone exactamente las rutas esperadas', () => {
    const rutas = Object.getOwnPropertyNames(EquipoController.prototype)
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
      ['obtener', 'GET', ':id'],
      ['crear', 'POST', '/'],
      ['actualizar', 'PATCH', ':id'],
      ['reenviarInvitacion', 'POST', ':id/reenviar-invitacion'],
      ['desactivar', 'DELETE', ':id'],
    ]);
  });

  it('pasa el usuario autenticado a los métodos que aplican el techo de privilegios', async () => {
    const user: IRequestUser = { uid: 'u', email: 'a@b.co', accountId: 'c1' };
    const servicio = {
      crear: jest.fn().mockResolvedValue({}),
      actualizar: jest.fn().mockResolvedValue({}),
      desactivar: jest.fn().mockResolvedValue({}),
      reenviarInvitacion: jest.fn().mockResolvedValue({}),
    };
    const c = new EquipoController(servicio as never);

    const dto = { nombre: 'N', email: 'n@x.co', permisos: ['tareas.ver'] };
    await c.crear(dto, user);
    await c.actualizar('m1', { permisos: [] }, user);
    await c.desactivar('m1', user);
    await c.reenviarInvitacion('m1');

    expect(servicio.crear).toHaveBeenCalledWith(dto, user);
    expect(servicio.actualizar).toHaveBeenCalledWith(
      'm1',
      { permisos: [] },
      user,
    );
    expect(servicio.desactivar).toHaveBeenCalledWith('m1', user);
    expect(servicio.reenviarInvitacion).toHaveBeenCalledWith('m1');
  });
});

describe('EquipoController — licencia: finanzas o administracion', () => {
  const rutas = [
    ['listar', 'usuarios.ver'],
    ['obtener', 'usuarios.ver'],
    ['crear', 'usuarios.crear'],
    ['actualizar', 'usuarios.editar'],
    ['reenviarInvitacion', 'usuarios.editar'],
    ['desactivar', 'usuarios.eliminar'],
  ] as const;

  it.each(rutas)(
    '%s abre con %s en una copropiedad solo con finanzas, solo con administracion o con ambos',
    (ruta, clave) => {
      for (const modulos of [
        ['finanzas'],
        ['administracion'],
        ['finanzas', 'administracion'],
      ] as const) {
        expect(
          guardDejaPasar(EquipoController, ruta, [clave], {
            modulos: [...modulos],
          }),
        ).toBe(true);
      }
    },
  );

  it.each(rutas)(
    '%s responde 403 sin ninguno de los dos módulos, aunque tenga la clave',
    (ruta, clave) => {
      expect(
        guardDejaPasar(EquipoController, ruta, [clave], { modulos: [] }),
      ).toBe(false);
    },
  );

  it.each(rutas)(
    '%s sigue pidiendo la clave usuarios.*: con finanzas pero sin ella, 403',
    (ruta) => {
      expect(
        guardDejaPasar(EquipoController, ruta, ['roles.gestionar'], {
          modulos: ['finanzas'],
        }),
      ).toBe(false);
    },
  );

  it('Residentes no cambia: solo con administracion', () => {
    expect(Reflect.getMetadata(MODULO_KEY, AccesoResidentesController)).toBe(
      'administracion',
    );
  });
});

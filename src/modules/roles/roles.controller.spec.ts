import 'reflect-metadata';
import {
  CHECK_ABILITY_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { createAppAbility } from '../casl/casl-ability.constants';
import { rulesFromPermissionKeys } from '../casl/permission-map';
import { RolesController } from './roles.controller';

/** The rules a handler requires, as the policies guard reads them. */
const requisitos = (handler: keyof RolesController): RequiredRule[] => {
  const metodo: unknown = Reflect.get(RolesController.prototype, handler);
  return Reflect.getMetadata(
    CHECK_ABILITY_KEY,
    metodo as object,
  ) as RequiredRule[];
};

/** Whether a caller holding `claves` clears every rule of the handler. */
const puede = (handler: keyof RolesController, claves: string[]): boolean => {
  const habilidad = createAppAbility(rulesFromPermissionKeys(claves));
  return requisitos(handler).every((r) => habilidad.can(r.action, r.subject));
};

describe('RolesController — permisos por ruta', () => {
  it('las lecturas (listar roles y el catálogo) piden solo leer Rol', () => {
    expect(requisitos('findAll')).toEqual([{ action: 'read', subject: 'Rol' }]);
    expect(requisitos('permisos')).toEqual([
      { action: 'read', subject: 'Rol' },
    ]);
  });

  it('roles.ver abre las lecturas pero no las escrituras', () => {
    expect(puede('findAll', ['roles.ver'])).toBe(true);
    expect(puede('permisos', ['roles.ver'])).toBe(true);
    expect(puede('create', ['roles.ver'])).toBe(false);
    expect(puede('update', ['roles.ver'])).toBe(false);
    expect(puede('remove', ['roles.ver'])).toBe(false);
  });

  it('roles.gestionar sigue abriendo todo', () => {
    for (const ruta of [
      'findAll',
      'permisos',
      'create',
      'update',
      'remove',
    ] as const) {
      expect(puede(ruta, ['roles.gestionar'])).toBe(true);
    }
  });

  it('sin ninguna clave de roles no se abre nada', () => {
    expect(puede('findAll', ['usuarios.ver'])).toBe(false);
  });
});

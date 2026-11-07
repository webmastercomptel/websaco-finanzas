import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { TareasController } from './tareas.controller';

/** The ability a handler declares, read from the same metadata the guard reads. */
const reglasDe = (handler: keyof TareasController): RequiredRule[] =>
  Reflect.getMetadata(
    CHECK_ABILITY_KEY,
    // Only the function object is read for its metadata; it is never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    TareasController.prototype[handler],
  ) as RequiredRule[];

describe('TareasController — política de acceso', () => {
  // Decisión de seguridad: `tareas.actualizar` (update) NO puede editar ni
  // borrar tareas ajenas; solo `tareas.gestionar` (manage) puede.
  it.each([
    ['listar', 'read'],
    ['crear', 'manage'],
    ['actualizar', 'manage'],
    ['eliminar', 'manage'],
    ['completar', 'update'],
    ['agregarObservacion', 'update'],
  ] as const)('%s exige la acción %s sobre Tarea', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Tarea' }]);
  });

  it('ninguna ruta de creación, edición o borrado se conforma con update', () => {
    for (const handler of ['crear', 'actualizar', 'eliminar'] as const) {
      expect(reglasDe(handler).map((r) => r.action)).not.toContain('update');
    }
  });

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, TareasController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, TareasController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });
});

describe('TareasController — delegación', () => {
  const user: IRequestUser = {
    uid: 'u',
    email: 'a@b.co',
    accountId: 'cuenta-1',
    nombre: 'Ana',
  };

  function montar() {
    const servicio = {
      listar: jest.fn().mockResolvedValue([]),
      crear: jest.fn().mockResolvedValue({ id: 't1' }),
      actualizar: jest.fn().mockResolvedValue({ id: 't1' }),
      eliminar: jest.fn().mockResolvedValue({ id: 't1' }),
      completar: jest.fn().mockResolvedValue({ id: 't1' }),
      agregarObservacion: jest.fn().mockResolvedValue({ id: 't1' }),
    };
    return { servicio, controlador: new TareasController(servicio as never) };
  }

  it('pasa el usuario autenticado y los filtros al servicio al listar', async () => {
    const { servicio, controlador } = montar();

    await controlador.listar({ estado: 'pendiente' }, user);

    expect(servicio.listar).toHaveBeenCalledWith({ estado: 'pendiente' }, user);
  });

  it('pasa solo el texto de la observación al servicio', async () => {
    const { servicio, controlador } = montar();

    await controlador.agregarObservacion('t1', { texto: 'Hola' }, user);

    expect(servicio.agregarObservacion).toHaveBeenCalledWith(
      't1',
      'Hola',
      user,
    );
  });

  it('delega crear, actualizar, completar y eliminar con id y usuario', async () => {
    const { servicio, controlador } = montar();

    await controlador.crear({ titulo: 'x', categoria: 'admin' }, user);
    await controlador.actualizar('t1', { titulo: 'y' }, user);
    await controlador.completar('t1', user);
    await controlador.eliminar('t1');

    expect(servicio.crear).toHaveBeenCalledWith(
      { titulo: 'x', categoria: 'admin' },
      user,
    );
    expect(servicio.actualizar).toHaveBeenCalledWith(
      't1',
      { titulo: 'y' },
      user,
    );
    expect(servicio.completar).toHaveBeenCalledWith('t1', user);
    expect(servicio.eliminar).toHaveBeenCalledWith('t1');
  });
});

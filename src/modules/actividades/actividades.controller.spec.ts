import 'reflect-metadata';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { ActividadesController } from './actividades.controller';

const manejador = (handler: keyof ActividadesController): object =>
  // Only the function object is read for its metadata; it is never called.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  ActividadesController.prototype[handler];

/** The ability a handler declares, read from the same metadata the guard reads. */
const reglasDe = (handler: keyof ActividadesController): RequiredRule[] =>
  Reflect.getMetadata(CHECK_ABILITY_KEY, manejador(handler)) as RequiredRule[];

describe('ActividadesController — política de acceso', () => {
  it.each([
    ['listar', 'read'],
    ['crear', 'manage'],
    ['actualizar', 'manage'],
    ['eliminar', 'manage'],
  ] as const)('%s exige la acción %s sobre Actividad', (handler, action) => {
    expect(reglasDe(handler)).toEqual([{ action, subject: 'Actividad' }]);
  });

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, ActividadesController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, ActividadesController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it('no expone ninguna ruta de asistencia: eso es del portal del residente', () => {
    const handlers = Object.getOwnPropertyNames(
      ActividadesController.prototype,
    ).filter(
      (n) =>
        n !== 'constructor' &&
        Reflect.getMetadata(
          METHOD_METADATA,
          manejador(n as keyof ActividadesController),
        ) !== undefined,
    );

    expect(handlers.sort()).toEqual([
      'actualizar',
      'crear',
      'eliminar',
      'listar',
    ]);
  });
});

describe('ActividadesController — delegación', () => {
  it('delega listar, crear, actualizar y eliminar en el servicio', async () => {
    const servicio = {
      listar: jest.fn().mockResolvedValue([]),
      crear: jest.fn().mockResolvedValue({ id: 'a1' }),
      actualizar: jest.fn().mockResolvedValue({ id: 'a1' }),
      eliminar: jest.fn().mockResolvedValue({ id: 'a1' }),
    };
    const controlador = new ActividadesController(servicio as never);
    const dto = {
      titulo: 'x',
      categoria: 'salud' as const,
      fecha: '2026-09-10T08:00:00.000Z',
    };

    await controlador.listar({ estado: 'proximo' });
    await controlador.crear(dto);
    await controlador.actualizar('a1', { titulo: 'y' });
    await controlador.eliminar('a1');

    expect(servicio.listar).toHaveBeenCalledWith({ estado: 'proximo' });
    expect(servicio.crear).toHaveBeenCalledWith(dto);
    expect(servicio.actualizar).toHaveBeenCalledWith('a1', { titulo: 'y' });
    expect(servicio.eliminar).toHaveBeenCalledWith('a1');
  });
});

import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  CHECK_ABILITY_KEY,
  MODULO_KEY,
  type RequiredRule,
} from '../casl/check-ability.decorator';
import { MantenimientosController } from './mantenimientos.controller';

const manejador = (handler: keyof MantenimientosController): object =>
  // Only the function object is read for its metadata; it is never called.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  MantenimientosController.prototype[handler];

/** The ability a handler declares, read from the same metadata the guard reads. */
const reglasDe = (handler: keyof MantenimientosController): RequiredRule[] =>
  Reflect.getMetadata(CHECK_ABILITY_KEY, manejador(handler)) as RequiredRule[];

describe('MantenimientosController — política de acceso', () => {
  // Decisión de seguridad: leer y escribir son permisos distintos.
  it.each([
    ['estadisticas', 'read'],
    ['listar', 'read'],
    ['crear', 'manage'],
    ['actualizar', 'manage'],
    ['eliminar', 'manage'],
  ] as const)(
    '%s exige la acción %s sobre Mantenimiento',
    (handler, action) => {
      expect(reglasDe(handler)).toEqual([{ action, subject: 'Mantenimiento' }]);
    },
  );

  it('declara el módulo administracion y los guards en orden (autenticación antes que políticas)', () => {
    expect(Reflect.getMetadata(MODULO_KEY, MantenimientosController)).toBe(
      'administracion',
    );
    const guards = (
      Reflect.getMetadata(GUARDS_METADATA, MantenimientosController) as Array<{
        name: string;
      }>
    ).map((g) => g.name);
    expect(guards).toEqual(['FirebaseAuthGuard', 'PoliciesGuard']);
  });

  it('declara /stats antes que cualquier ruta :id para que no la absorba', () => {
    const rutas = Object.getOwnPropertyNames(MantenimientosController.prototype)
      .filter((n) => n !== 'constructor')
      .filter(
        (n) =>
          Reflect.getMetadata(
            METHOD_METADATA,
            manejador(n as keyof MantenimientosController),
          ) !== undefined,
      )
      .map((n) =>
        String(
          Reflect.getMetadata(
            PATH_METADATA,
            manejador(n as keyof MantenimientosController),
          ),
        ),
      );

    expect(rutas.indexOf('stats')).toBeGreaterThanOrEqual(0);
    expect(rutas.indexOf('stats')).toBeLessThan(rutas.indexOf(':id'));
  });
});

describe('MantenimientosController — delegación', () => {
  function montar() {
    const servicio = {
      estadisticas: jest.fn().mockResolvedValue({}),
      listar: jest.fn().mockResolvedValue([]),
      crear: jest.fn().mockResolvedValue({ id: 'm1' }),
      actualizar: jest.fn().mockResolvedValue({ id: 'm1' }),
      eliminar: jest.fn().mockResolvedValue({ id: 'm1' }),
    };
    return {
      servicio,
      controlador: new MantenimientosController(servicio as never),
    };
  }

  it('pasa los filtros al servicio al listar', async () => {
    const { servicio, controlador } = montar();

    await controlador.listar({ tipo: 'correctivo' });

    expect(servicio.listar).toHaveBeenCalledWith({ tipo: 'correctivo' });
  });

  it('delega estadísticas, crear, actualizar y eliminar', async () => {
    const { servicio, controlador } = montar();
    const dto = {
      titulo: 'x',
      tipo: 'preventivo' as const,
      fecha: '2026-09-10T08:00:00.000Z',
      proveedor: { nombre: 'Ana' },
    };

    await controlador.estadisticas();
    await controlador.crear(dto);
    await controlador.actualizar('m1', { titulo: 'y' });
    await controlador.eliminar('m1');

    expect(servicio.estadisticas).toHaveBeenCalledTimes(1);
    expect(servicio.crear).toHaveBeenCalledWith(dto);
    expect(servicio.actualizar).toHaveBeenCalledWith('m1', { titulo: 'y' });
    expect(servicio.eliminar).toHaveBeenCalledWith('m1');
  });
});

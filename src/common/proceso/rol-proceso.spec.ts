import {
  ROLES_PROCESO,
  ejecutaTareasProgramadas,
  ejecutaTrabajadoresDeCola,
  establecerRolProceso,
  rolProcesoActual,
} from './rol-proceso';

describe('rol del proceso', () => {
  afterEach(() => establecerRolProceso('all'));

  it('los roles válidos son all, api y worker', () => {
    expect([...ROLES_PROCESO]).toEqual(['all', 'api', 'worker']);
  });

  it('sin decirlo, un proceso es all (comportamiento previo)', () => {
    expect(rolProcesoActual()).toBe('all');
  });

  it.each([
    ['all', true],
    ['worker', true],
    ['api', false],
  ] as const)(
    'el rol %s ejecuta los trabajadores de cola: %s',
    (rol, esperado) => {
      expect(ejecutaTrabajadoresDeCola(rol)).toBe(esperado);
    },
  );

  it.each([
    ['all', true],
    ['worker', true],
    ['api', false],
  ] as const)(
    'el rol %s ejecuta las tareas programadas: %s',
    (rol, esperado) => {
      expect(ejecutaTareasProgramadas(rol)).toBe(esperado);
    },
  );

  it('establecerRolProceso lo deja disponible para el resto del proceso', () => {
    establecerRolProceso('api');
    expect(rolProcesoActual()).toBe('api');
  });
});

import { modulosEfectivos } from './modulos';

describe('modulosEfectivos', () => {
  it('una copropiedad sin el campo se trata como solo finanzas', () => {
    expect(modulosEfectivos({})).toEqual(['finanzas']);
    expect(modulosEfectivos(null)).toEqual(['finanzas']);
  });

  it('una lista vacía se trata como solo finanzas', () => {
    expect(modulosEfectivos({ modulosContratados: [] })).toEqual(['finanzas']);
  });

  it('respeta los módulos contratados, sin duplicados', () => {
    expect(
      modulosEfectivos({
        modulosContratados: ['administracion', 'administracion'],
      }),
    ).toEqual(['administracion']);
    expect(
      modulosEfectivos({ modulosContratados: ['finanzas', 'administracion'] }),
    ).toEqual(['finanzas', 'administracion']);
  });

  it('descarta valores desconocidos y cae a finanzas si no queda ninguno', () => {
    expect(modulosEfectivos({ modulosContratados: ['nomina'] })).toEqual([
      'finanzas',
    ]);
  });
});

import { ForbiddenException } from '@nestjs/common';
import { exigirModulo } from './exigir-modulo';

describe('exigirModulo', () => {
  it('deja pasar cuando la ruta no declara módulo', () => {
    expect(() => exigirModulo(undefined, { modulos: [] })).not.toThrow();
  });

  it('exige el módulo único declarado', () => {
    expect(() =>
      exigirModulo('finanzas', { modulos: ['administracion'] }),
    ).toThrow(ForbiddenException);
    expect(() =>
      exigirModulo('finanzas', { modulos: ['finanzas'] }),
    ).not.toThrow();
  });

  it('con una lista de módulos basta con tener uno de ellos', () => {
    const ruta = ['finanzas', 'administracion'];
    expect(() =>
      exigirModulo(ruta, { modulos: ['administracion'] }),
    ).not.toThrow();
    expect(() => exigirModulo(ruta, { modulos: ['finanzas'] })).not.toThrow();
  });

  it('con una lista, deniega a quien no tiene ninguno (o no tiene copropiedad activa)', () => {
    const ruta = ['finanzas', 'administracion'];
    expect(() => exigirModulo(ruta, { modulos: [] })).toThrow(
      ForbiddenException,
    );
    expect(() => exigirModulo(ruta, { modulos: undefined })).toThrow(
      ForbiddenException,
    );
  });

  it('una lista vacía deniega siempre (falla cerrado)', () => {
    expect(() => exigirModulo([], { modulos: ['finanzas'] })).toThrow(
      ForbiddenException,
    );
  });
});

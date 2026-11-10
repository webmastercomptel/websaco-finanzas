import { Types } from 'mongoose';
import { toAsignacionResumen } from './usuarios.mapper';

const asignacion = (over: Record<string, unknown> = {}) =>
  ({
    alcance: 'copropiedad',
    copropiedadId: new Types.ObjectId(),
    entidadId: null,
    permisos: ['pqr.ver'],
    ...over,
  }) as never;

describe('toAsignacionResumen — perfil', () => {
  it('expone el perfil de la asignación', () => {
    expect(toAsignacionResumen(asignacion({ perfil: 'personal' })).perfil).toBe(
      'personal',
    );
    expect(
      toAsignacionResumen(asignacion({ perfil: 'administrativo' })).perfil,
    ).toBe('administrativo');
  });

  it('una fila antigua sin perfil se lee como administrativo', () => {
    expect(toAsignacionResumen(asignacion()).perfil).toBe('administrativo');
  });
});

import { Types } from 'mongoose';
import { toRegistroPanel } from './integraciones-panel.mapper';

const base = {
  _id: new Types.ObjectId('670000000000000000000001'),
  nombre: 'Conjunto Los Pinos',
  nit: '900123456',
  digitoVerificacion: '7',
  comptableEmpresaId: null,
};

describe('toRegistroPanel', () => {
  it('une NIT y dígito de verificación como nit-dv', () => {
    expect(toRegistroPanel(base).nit).toBe('900123456-7');
  });

  it('sin dígito de verificación devuelve solo el NIT', () => {
    expect(toRegistroPanel({ ...base, digitoVerificacion: null }).nit).toBe(
      '900123456',
    );
  });

  it('sin NIT devuelve null aunque haya dígito', () => {
    expect(toRegistroPanel({ ...base, nit: null }).nit).toBeNull();
  });

  it('el id sale como string y el nombre tal cual', () => {
    const registro = toRegistroPanel(base);

    expect(registro.id).toBe('670000000000000000000001');
    expect(registro.nombre).toBe('Conjunto Los Pinos');
  });

  it('sin vínculos devuelve la lista vacía', () => {
    expect(toRegistroPanel(base).vinculos).toEqual([]);
  });

  it('solo incluye los vínculos no nulos, con los nombres de sistema del contrato', () => {
    const registro = toRegistroPanel({
      ...base,
      comptableEmpresaId: 'a'.repeat(24),
      // A legacy link to the retired Administración system is never exposed.
      websaco3CopropiedadId: 'b'.repeat(24),
    } as never);

    expect(registro.vinculos).toEqual([
      { sistema: 'comptable', registroId: 'a'.repeat(24) },
    ]);
  });

  it('un documento legado sin las claves se lee como sin vínculos', () => {
    const legado = {
      _id: base._id,
      nombre: base.nombre,
      nit: null,
      digitoVerificacion: null,
    };

    expect(toRegistroPanel(legado).vinculos).toEqual([]);
  });

  it('los ids de vínculo salen en minúsculas aunque estén guardados sin normalizar', () => {
    const registro = toRegistroPanel({
      ...base,
      comptableEmpresaId: 'A'.repeat(24),
    });

    expect(registro.vinculos).toEqual([
      { sistema: 'comptable', registroId: 'a'.repeat(24) },
    ]);
  });

  it('nunca expone campos del documento fuera del contrato', () => {
    const registro = toRegistroPanel({
      ...base,
      cuentaContableCartera: '130505',
    } as never);

    expect(Object.keys(registro).sort()).toEqual([
      'id',
      'nit',
      'nombre',
      'vinculos',
    ]);
  });
});

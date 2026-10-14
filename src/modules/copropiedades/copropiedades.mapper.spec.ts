import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import { toCopropiedad } from './copropiedades.mapper';

const documento = (over: Record<string, unknown> = {}) =>
  ({
    _id: { toString: () => 'cop-1' },
    codigo: '0001',
    nombre: 'Terrazas de Granada',
    nit: null,
    digitoVerificacion: null,
    direccion: null,
    ciudad: null,
    telefono: null,
    email: null,
    mostrarLogo: true,
    entidadId: null,
    nombreAdministrador: null,
    estado: 'active',
    usaGestionEdificios: false,
    cuentaContableCartera: null,
    cuentaAnticipos: null,
    cuentaDevoluciones: null,
    cuentaNotasDebito: null,
    ...over,
  }) as unknown as CopropiedadDocument;

describe('toCopropiedad — websaco3CopropiedadId', () => {
  it('expone el id guardado', () => {
    const doc = documento({
      usaGestionEdificios: true,
      websaco3CopropiedadId: '64b7f0c2a1d4e5f6a7b8c9d0',
    });

    expect(toCopropiedad(doc).websaco3CopropiedadId).toBe(
      '64b7f0c2a1d4e5f6a7b8c9d0',
    );
  });

  it('un documento legacy sin el campo se mapea a null', () => {
    // La clave ni siquiera existe en el documento (anterior a este campo).
    expect(toCopropiedad(documento()).websaco3CopropiedadId).toBeNull();
  });
});

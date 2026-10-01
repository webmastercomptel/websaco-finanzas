import { comoNombrePropio, nombrePropio } from './nombre-propio';

describe('nombrePropio', () => {
  it('pone en mayúscula la primera letra de cada palabra y el resto en minúscula', () => {
    expect(nombrePropio('PEREZ GÓMEZ JUAN ÑUSTES')).toBe(
      'Perez Gómez Juan Ñustes',
    );
    expect(nombrePropio('caja general')).toBe('Caja General');
  });

  it('deja en mayúscula las siglas', () => {
    expect(nombrePropio('EDIFICIO LOS PINOS P.H.')).toBe(
      'Edificio Los Pinos P.H.',
    );
    expect(nombrePropio('ALMACENES ÉXITO S.A.S.')).toBe(
      'Almacenes Éxito S.A.S.',
    );
    expect(nombrePropio('iva por pagar')).toBe('IVA por Pagar');
    expect(nombrePropio('TORRE II')).toBe('Torre II');
    expect(nombrePropio('INTERESES POR MORA [CR]')).toBe(
      'Intereses por Mora [CR]',
    );
  });

  it('deja los conectores en minúscula salvo al inicio', () => {
    expect(nombrePropio('EDIFICIO TERRAZAS DE COLOMBIA')).toBe(
      'Edificio Terrazas de Colombia',
    );
    expect(nombrePropio('Intereses por Mora')).toBe('Intereses por Mora');
    expect(nombrePropio('DE LA TORRE MARIA')).toBe('De la Torre Maria');
    expect(nombrePropio('PEREZ Y CIA')).toBe('Perez y CIA');
  });

  it('respeta los artículos de un nombre propio salvo después de "de"', () => {
    expect(nombrePropio('CONJUNTO EL ROBLE')).toBe('Conjunto El Roble');
    expect(nombrePropio('MARIA DE LA TORRE')).toBe('Maria de la Torre');
    expect(nombrePropio('BANCO DE LOS ANDES')).toBe('Banco de los Andes');
  });

  it('no confunde iniciales con conectores', () => {
    expect(nombrePropio('JUAN E PEREZ')).toBe('Juan E Perez');
  });

  it('respeta siglas de forma mixta y de bancos', () => {
    expect(nombrePropio('CXC MULTAS')).toBe('CxC Multas');
    expect(nombrePropio('Banco BBVA')).toBe('Banco BBVA');
    expect(nombrePropio('Administraciones BRC')).toBe('Administraciones BRC');
  });

  it('separa palabras por guion y apóstrofo', () => {
    expect(nombrePropio('RUIZ-GOMEZ')).toBe('Ruiz-Gomez');
    expect(nombrePropio("O'BRIEN")).toBe("O'Brien");
  });

  it('es idempotente', () => {
    const una = nombrePropio('CONJUNTO RESIDENCIAL EL ROBLE');
    expect(nombrePropio(una)).toBe(una);
  });
});

describe('comoNombrePropio', () => {
  it('deja pasar lo que no es texto', () => {
    expect(comoNombrePropio(null)).toBeNull();
    const regex = /CAJA/i;
    expect(comoNombrePropio(regex)).toBe(regex);
  });
});

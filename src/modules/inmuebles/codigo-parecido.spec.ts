import { claveParecida } from './codigo-parecido';

describe('claveParecida', () => {
  it('"A-01" y "a1" comparten clave', () => {
    expect(claveParecida('A-01')).toBe('a1');
    expect(claveParecida('a1')).toBe('a1');
  });

  it('"301" y "0301" comparten clave: los ceros a la izquierda no cuentan', () => {
    expect(claveParecida('0301')).toBe('301');
    expect(claveParecida('301')).toBe('301');
  });

  it('"301" y "3010" NO comparten clave', () => {
    expect(claveParecida('301')).not.toBe(claveParecida('3010'));
  });

  it('quita espacios y los separadores - _ . /', () => {
    expect(claveParecida(' Torre 2 - 0301 ')).toBe('torre2|301');
    expect(claveParecida('torre2301')).toBe('torre2301');
    expect(claveParecida('T_2.03/01')).toBe('t2|3|1');
  });

  it('quita los ceros a la izquierda de CADA grupo de dígitos, no solo del primero', () => {
    expect(claveParecida('A-01-002')).toBe('a1|2');
    expect(claveParecida('01A002')).toBe('1a2');
  });

  it('un grupo solo de ceros conserva uno: cero es un valor, no relleno', () => {
    expect(claveParecida('000')).toBe('0');
    expect(claveParecida('A-00')).toBe('a0');
    expect(claveParecida('A-10')).toBe('a10');
  });

  it('un cero en medio o al final de un grupo no se toca', () => {
    expect(claveParecida('3010')).toBe('3010');
    expect(claveParecida('1001')).toBe('1001');
  });

  it('entradas vacías o raras dan clave vacía sin lanzar', () => {
    expect(claveParecida('')).toBe('');
    expect(claveParecida('   ')).toBe('');
    expect(claveParecida('-_./')).toBe('');
    expect(claveParecida(undefined)).toBe('');
    expect(claveParecida(null)).toBe('');
    expect(claveParecida(301)).toBe('');
  });

  it('un separador ENTRE dos dígitos se conserva como marcador: "1-23" y "12-3" no colisionan', () => {
    expect(claveParecida('1-23')).toBe('1|23');
    expect(claveParecida('12-3')).toBe('12|3');
    expect(claveParecida('1-23')).not.toBe(claveParecida('12-3'));
    expect(claveParecida('A-1-01')).toBe('a1|1');
    expect(claveParecida('A-10-1')).toBe('a10|1');
    expect(claveParecida('A-1-01')).not.toBe(claveParecida('A-10-1'));
  });

  it('un separador en cualquier otro lugar se descarta: "A-01" y "a1" siguen coincidiendo', () => {
    expect(claveParecida('A-01')).toBe(claveParecida('a1'));
    expect(claveParecida('A 1')).toBe('a1');
    expect(claveParecida('-A1-')).toBe('a1');
    expect(claveParecida('1 2')).toBe(claveParecida('1-2'));
  });

  it('letras distintas siguen siendo distintas', () => {
    expect(claveParecida('A-301')).not.toBe(claveParecida('B-301'));
  });
});

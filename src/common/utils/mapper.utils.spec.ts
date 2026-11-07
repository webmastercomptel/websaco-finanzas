import { iniciales } from './mapper.utils';

describe('iniciales', () => {
  it.each([
    ['Laura Gómez', 'LG'],
    ['Administración', 'A'],
    ['  ana   maría  de la cruz ', 'AC'],
    ['', ''],
    [undefined, ''],
    [null, ''],
  ])('%p -> %p', (nombre, esperado) => {
    expect(iniciales(nombre)).toBe(esperado);
  });
});

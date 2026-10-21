import { esEmailValido, parseEmails } from './email.utils';

describe('esEmailValido', () => {
  it('acepta una dirección con forma usuario@dominio.tld', () => {
    expect(esEmailValido('a@x.co')).toBe(true);
    expect(esEmailValido('nombre.apellido+tag@sub.dominio.com')).toBe(true);
  });

  it('rechaza valores sin arroba, sin dominio o sin punto en el dominio', () => {
    expect(esEmailValido('bad')).toBe(false);
    expect(esEmailValido('bad@')).toBe(false);
    expect(esEmailValido('@x.co')).toBe(false);
    expect(esEmailValido('a@x')).toBe(false);
  });

  it('rechaza vacíos y espacios, también los que rodean una dirección buena', () => {
    expect(esEmailValido('')).toBe(false);
    expect(esEmailValido('   ')).toBe(false);
    expect(esEmailValido(' a@x.co ')).toBe(false);
    expect(esEmailValido('a b@x.co')).toBe(false);
  });
});

describe('parseEmails', () => {
  it('devuelve [] para vacío o undefined', () => {
    expect(parseEmails(undefined)).toEqual([]);
    expect(parseEmails('')).toEqual([]);
  });

  it('separa por coma o punto y coma y recorta', () => {
    expect(parseEmails(' a@x.co ; b@x.co,c@x.co ')).toEqual([
      'a@x.co',
      'b@x.co',
      'c@x.co',
    ]);
  });

  it('ignora segmentos vacíos', () => {
    expect(parseEmails('a@x.co,, ;b@x.co')).toEqual(['a@x.co', 'b@x.co']);
  });

  it('lanza con la primera dirección inválida', () => {
    expect(() => parseEmails('a@x.co; bad ;worse')).toThrow(
      '"bad" no es un correo válido',
    );
  });
});

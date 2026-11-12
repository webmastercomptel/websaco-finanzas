import { createHash } from 'node:crypto';
import {
  claveCorreo,
  enmascararEmail,
  esEmailValido,
  formatEmails,
  MAX_CORREOS_POR_TERCERO,
  normalizarEmail,
  normalizarListaEmails,
  parseEmails,
} from './email.utils';

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

describe('formatEmails', () => {
  it('une las direcciones con coma y espacio, y devuelve "" sin direcciones', () => {
    expect(formatEmails(['a@x.co', 'b@y.co'])).toBe('a@x.co, b@y.co');
    expect(formatEmails([])).toBe('');
    expect(formatEmails(undefined)).toBe('');
  });

  it('es la inversa de parseEmails: ida y vuelta sin pérdida', () => {
    const correos = ['ana@ejemplo.com', 'gestor+tag@sub.ejemplo.co'];

    expect(parseEmails(formatEmails(correos))).toEqual(correos);
  });
});

describe('normalizarEmail', () => {
  it('recorta y pasa a minúsculas', () => {
    expect(normalizarEmail('  Ana@X.COM ')).toBe('ana@x.com');
  });
});

describe('claveCorreo', () => {
  it('es el SHA-256 hex (64 caracteres) del correo normalizado con el prefijo versionado', () => {
    const esperado = createHash('sha256')
      .update('correo:v1:ana@x.com')
      .digest('hex');

    expect(claveCorreo('ana@x.com')).toBe(esperado);
    expect(claveCorreo('ana@x.com')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('es estable e insensible a mayúsculas y espacios', () => {
    expect(claveCorreo(' Ana@X.com ')).toBe(claveCorreo('ana@x.com'));
  });

  it('distingue correos distintos', () => {
    expect(claveCorreo('a@x.com')).not.toBe(claveCorreo('b@x.com'));
  });
});

describe('normalizarListaEmails', () => {
  it('devuelve [] para vacío o undefined', () => {
    expect(normalizarListaEmails(undefined)).toEqual([]);
    expect(normalizarListaEmails('')).toEqual([]);
  });

  it('separa por coma o punto y coma y deduplica sin distinguir mayúsculas, conservando la primera grafía', () => {
    expect(normalizarListaEmails('a@x.com; A@x.com, b@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
    ]);
    expect(normalizarListaEmails('Ana@x.com, ana@X.COM')).toEqual([
      'Ana@x.com',
    ]);
  });

  it('una entrada inválida conserva el mensaje existente', () => {
    expect(() => normalizarListaEmails('a@x.co; bad ;worse')).toThrow(
      '"bad" no es un correo válido',
    );
  });

  it('acepta 5 distintos, el tope se cuenta después de deduplicar', () => {
    const cinco = 'a@x.co,b@x.co,c@x.co,d@x.co,e@x.co';

    expect(normalizarListaEmails(cinco)).toHaveLength(5);
    expect(MAX_CORREOS_POR_TERCERO).toBe(5);
    expect(normalizarListaEmails(`${cinco},A@x.co,B@x.co`)).toHaveLength(5);
  });

  it('con 6 distintos lanza «Máximo 5 correos»', () => {
    expect(() =>
      normalizarListaEmails('a@x.co,b@x.co,c@x.co,d@x.co,e@x.co,f@x.co'),
    ).toThrow('Máximo 5 correos');
  });
});

describe('enmascararEmail', () => {
  it('deja la primera letra, *** y el dominio', () => {
    expect(enmascararEmail('juan@x.co')).toBe('j***@x.co');
    expect(enmascararEmail('ana@x.com')).toBe('a***@x.com');
  });

  it('sin arroba devuelve ***', () => {
    expect(enmascararEmail('no-es-correo')).toBe('***');
    expect(enmascararEmail('')).toBe('***');
  });
});

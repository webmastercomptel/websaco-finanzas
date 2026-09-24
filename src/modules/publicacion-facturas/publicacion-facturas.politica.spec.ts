import {
  BACKOFF_MS,
  clasificarRespuesta,
  retrasoTras,
} from './publicacion-facturas.politica';

describe('clasificarRespuesta', () => {
  it.each([200, 201, 202, 204, 299, 409])(
    'clasifica %i como enviado',
    (status) => {
      expect(clasificarRespuesta(status)).toBe('enviado');
    },
  );

  it.each([422, 429, 500, 502, 503, 599])(
    'clasifica %i como reintentar',
    (status) => {
      expect(clasificarRespuesta(status)).toBe('reintentar');
    },
  );

  it.each([401, 403])('clasifica %i como terminal', (status) => {
    expect(clasificarRespuesta(status)).toBe('terminal');
  });

  it.each([400, 404, 413])(
    'clasifica cualquier otro 4xx (%i) como terminal [spec-gap]',
    (status) => {
      expect(clasificarRespuesta(status)).toBe('terminal');
    },
  );
});

describe('retrasoTras', () => {
  it('sigue el calendario 1m/5m/15m/1h para los primeros 4 intentos', () => {
    expect(retrasoTras(1)).toBe(BACKOFF_MS[0]);
    expect(retrasoTras(2)).toBe(BACKOFF_MS[1]);
    expect(retrasoTras(3)).toBe(BACKOFF_MS[2]);
    expect(retrasoTras(4)).toBe(BACKOFF_MS[3]);
  });

  it('más allá del calendario, se clampea al último paso (1h)', () => {
    expect(retrasoTras(5)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
    expect(retrasoTras(6)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });
});

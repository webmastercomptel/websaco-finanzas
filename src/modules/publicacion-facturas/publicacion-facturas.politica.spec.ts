import {
  BACKOFF_MS,
  CLAIM_TTL_MS,
  FETCH_TIMEOUT_MS,
  MARGEN_CICLO_MS,
  PRESUPUESTO_CICLO_MS,
  URL_LECTURA_TTL_MS,
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

  it.each([400, 404])(
    'clasifica %i (id inválido / desconocido en WebSaco3) como terminal',
    (status) => {
      expect(clasificarRespuesta(status)).toBe('terminal');
    },
  );

  it.each([413, 418])(
    'clasifica cualquier otro 4xx (%i) como terminal',
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

// El fetch espera un arranque en frío de WebSaco3 (Cloud Run escala a cero).
// Estas invariantes fijan la relación entre los tiempos: si alguien sube el
// timeout sin revisar el resto, el barrido manual dejaría de enviar ninguna
// fila por ciclo, o un envío en curso se confundiría con un reclamo caído.
describe('presupuesto de tiempos de la publicación', () => {
  it('FETCH_TIMEOUT_MS es 45 s (cubre el arranque en frío del receptor)', () => {
    expect(FETCH_TIMEOUT_MS).toBe(45_000);
  });

  it('un ciclo del barrido manual cabe al menos un envío: FETCH_TIMEOUT_MS + MARGEN_CICLO_MS < PRESUPUESTO_CICLO_MS', () => {
    expect(FETCH_TIMEOUT_MS + MARGEN_CICLO_MS).toBeLessThan(
      PRESUPUESTO_CICLO_MS,
    );
  });

  it('un envío en curso nunca se confunde con un reclamo caído: FETCH_TIMEOUT_MS + MARGEN_CICLO_MS < CLAIM_TTL_MS', () => {
    expect(FETCH_TIMEOUT_MS + MARGEN_CICLO_MS).toBeLessThan(CLAIM_TTL_MS);
  });

  it('el ciclo no sobrevive a los reclamos que tomó: PRESUPUESTO_CICLO_MS < CLAIM_TTL_MS', () => {
    expect(PRESUPUESTO_CICLO_MS).toBeLessThan(CLAIM_TTL_MS);
  });

  it('la URL de lectura dura más que el timeout, para que un 202 alcance a descargar', () => {
    expect(URL_LECTURA_TTL_MS).toBeGreaterThan(FETCH_TIMEOUT_MS);
  });
});

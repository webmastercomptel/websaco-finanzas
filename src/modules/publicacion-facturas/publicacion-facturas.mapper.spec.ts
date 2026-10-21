import { construirPayload, periodoDeLote } from './publicacion-facturas.mapper';

describe('construirPayload', () => {
  const fila = {
    loteId: 'lote-1',
    numerosFactura: ['FV-3', 'FV-1', 'FV-2'],
  };
  const websaco3CopropiedadId = '507f1f77bcf86cd799439011';
  const url = 'https://storage.googleapis.com/bucket/lote-1.pdf?signed=1';
  const expiresAt = new Date('2026-09-24T12:00:00.000Z');

  it('arma la forma exacta del contrato', () => {
    const payload = construirPayload(
      fila,
      websaco3CopropiedadId,
      url,
      expiresAt,
    );

    expect(payload).toEqual({
      websaco3CopropiedadId: '507f1f77bcf86cd799439011',
      loteId: 'lote-1',
      facturas: [
        { numeroFactura: 'FV-3' },
        { numeroFactura: 'FV-1' },
        { numeroFactura: 'FV-2' },
      ],
      urlSigned: url,
      urlExpiresAt: '2026-09-24T12:00:00.000Z',
    });
  });

  it('el payload lleva websaco3CopropiedadId y no lleva nit', () => {
    const payload = construirPayload(
      fila,
      websaco3CopropiedadId,
      url,
      expiresAt,
    );

    expect(payload.websaco3CopropiedadId).toBe(websaco3CopropiedadId);
    expect(payload).not.toHaveProperty('nit');
  });

  it('ignora un nit residual en la fila legacy: nunca llega al payload', () => {
    const filaLegacy = { ...fila, nit: '900123456' };

    const payload = construirPayload(
      filaLegacy,
      websaco3CopropiedadId,
      url,
      expiresAt,
    );

    expect(payload).not.toHaveProperty('nit');
    expect(JSON.stringify(payload)).not.toContain('900123456');
  });

  it('preserva el orden de numerosFactura sin reordenarlo', () => {
    const payload = construirPayload(
      fila,
      websaco3CopropiedadId,
      url,
      expiresAt,
    );

    expect(payload.facturas.map((f) => f.numeroFactura)).toEqual([
      'FV-3',
      'FV-1',
      'FV-2',
    ]);
  });

  it('formatea urlExpiresAt como ISO-8601', () => {
    const payload = construirPayload(
      fila,
      websaco3CopropiedadId,
      url,
      expiresAt,
    );

    expect(payload.urlExpiresAt).toBe(expiresAt.toISOString());
  });

  it('convierte un loteId de ObjectId (con toString) a string', () => {
    const loteIdObjeto = { toString: () => 'lote-objectid-1' };
    const payload = construirPayload(
      { ...fila, loteId: loteIdObjeto as unknown as string },
      websaco3CopropiedadId,
      url,
      expiresAt,
    );

    expect(payload.loteId).toBe('lote-objectid-1');
  });
});

describe('construirPayload — periodo', () => {
  const fila = { loteId: 'lote-1', numerosFactura: ['FV-1'] };
  const url = 'https://storage.googleapis.com/bucket/lote-1.pdf?signed=1';
  const expiresAt = new Date('2026-09-24T12:00:00.000Z');

  it('incluye periodo cuando se conoce', () => {
    const payload = construirPayload(
      fila,
      '507f1f77bcf86cd799439011',
      url,
      expiresAt,
      '2026-11',
    );

    expect(payload.periodo).toBe('2026-11');
  });

  it('omite la clave periodo (no la manda null) cuando no se conoce', () => {
    const payload = construirPayload(
      fila,
      '507f1f77bcf86cd799439011',
      url,
      expiresAt,
    );

    expect(payload).not.toHaveProperty('periodo');
    expect(JSON.stringify(payload)).not.toContain('periodo');
  });
});

describe('periodoDeLote', () => {
  it('toma el mes UTC de periodoDesde', () => {
    expect(periodoDeLote(new Date('2026-11-15T00:00:00.000Z'))).toBe('2026-11');
  });

  it('el día 1 a medianoche UTC sigue siendo ese mes (como el título del lote en la UI)', () => {
    // Un cálculo en America/Bogotá (UTC-5) daría 2026-10 y no coincidiría con
    // "Noviembre de 2026" que muestra el selector de lotes.
    expect(periodoDeLote(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
  });

  it('el último instante de un mes UTC no salta al siguiente', () => {
    expect(periodoDeLote(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
  });

  it('cruza el año correctamente', () => {
    expect(periodoDeLote(new Date('2027-01-01T00:00:00.000Z'))).toBe('2027-01');
  });

  it.each([null, undefined, new Date('no-es-fecha')])(
    'devuelve undefined sin fecha utilizable (%p)',
    (valor) => {
      expect(periodoDeLote(valor)).toBeUndefined();
    },
  );
});

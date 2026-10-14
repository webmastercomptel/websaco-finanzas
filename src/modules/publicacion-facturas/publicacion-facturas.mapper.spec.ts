import { construirPayload } from './publicacion-facturas.mapper';

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

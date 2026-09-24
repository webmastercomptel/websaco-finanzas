import { construirPayload } from './publicacion-facturas.mapper';

describe('construirPayload', () => {
  const fila = {
    taxId: '900123456',
    loteId: 'lote-1',
    invoiceNumbers: ['FV-3', 'FV-1', 'FV-2'],
  };
  const url = 'https://storage.googleapis.com/bucket/lote-1.pdf?signed=1';
  const expiresAt = new Date('2026-09-24T12:00:00.000Z');

  it('arma la forma exacta del contrato', () => {
    const payload = construirPayload(fila, url, expiresAt);

    expect(payload).toEqual({
      nit: '900123456',
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

  it('preserva el orden de invoiceNumbers sin reordenarlo', () => {
    const payload = construirPayload(fila, url, expiresAt);

    expect(payload.facturas.map((f) => f.numeroFactura)).toEqual([
      'FV-3',
      'FV-1',
      'FV-2',
    ]);
  });

  it('formatea urlExpiresAt como ISO-8601', () => {
    const payload = construirPayload(fila, url, expiresAt);

    expect(payload.urlExpiresAt).toBe(expiresAt.toISOString());
  });

  it('convierte un loteId de ObjectId (con toString) a string', () => {
    const loteIdObjeto = { toString: () => 'lote-objectid-1' };
    const payload = construirPayload(
      { ...fila, loteId: loteIdObjeto as unknown as string },
      url,
      expiresAt,
    );

    expect(payload.loteId).toBe('lote-objectid-1');
  });
});

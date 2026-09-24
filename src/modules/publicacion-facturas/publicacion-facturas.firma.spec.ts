import { firmar } from './publicacion-facturas.firma';

const SECRET = 'un-secreto-compartido-de-al-menos-32-caracteres';
const TIMESTAMP = '1700000000';
const BODY = '{"nit":"900123456","loteId":"lote-1"}';

describe('firmar', () => {
  it('es determinística: mismos timestamp/secret/body producen la misma firma', () => {
    const firma1 = firmar(SECRET, TIMESTAMP, BODY);
    const firma2 = firmar(SECRET, TIMESTAMP, BODY);

    expect(firma1).toBe(firma2);
    expect(firma1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un timestamp distinto produce una firma distinta', () => {
    const firma1 = firmar(SECRET, TIMESTAMP, BODY);
    const firma2 = firmar(SECRET, '1700000001', BODY);

    expect(firma1).not.toBe(firma2);
  });

  it('un cuerpo distinto produce una firma distinta', () => {
    const firma1 = firmar(SECRET, TIMESTAMP, BODY);
    const firma2 = firmar(SECRET, TIMESTAMP, `${BODY} `);

    expect(firma1).not.toBe(firma2);
  });

  it('un secreto distinto produce una firma distinta', () => {
    const firma1 = firmar(SECRET, TIMESTAMP, BODY);
    const firma2 = firmar(
      'otro-secreto-de-al-menos-32-caracteres-x',
      TIMESTAMP,
      BODY,
    );

    expect(firma1).not.toBe(firma2);
  });
});

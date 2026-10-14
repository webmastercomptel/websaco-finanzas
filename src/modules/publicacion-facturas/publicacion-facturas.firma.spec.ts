import { firmar } from './publicacion-facturas.firma';

const SECRET = 'un-secreto-compartido-de-al-menos-32-caracteres';
const TIMESTAMP = '1700000000';
const BODY =
  '{"websaco3CopropiedadId":"507f1f77bcf86cd799439099","loteId":"lote-1"}';

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

  // Golden vector shared with WebSaco3 (its firma.spec holds the same values);
  // the body has non-ASCII characters on purpose, since the signature is over
  // the raw UTF-8 bytes. Keep identical to the WebSaco3-side test.
  it('coincide con el vector de referencia compartido con WebSaco3', () => {
    const firma = firmar(
      'golden-vector-secret-0123456789abcdef',
      '1790000000',
      '{"loteId":"lote-golden-1","nombre":"Peña — 😀","facturas":[{"numeroFactura":"FV-1"}]}',
    );

    expect(`sha256=${firma}`).toBe(
      'sha256=8ed93fed4c6b1b779ff2295cdd3ff7a117736b3e53ec3550db27299a09d1c9cc',
    );
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

import { hmacHexEquals, hmacSha256Hex } from './hmac';

describe('hmacSha256Hex', () => {
  it('coincide con el vector de prueba de la RFC 4231 (caso 2)', () => {
    expect(hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('firma los bytes UTF-8 del mensaje', () => {
    // Vector de referencia de la publicación de facturas (mismo que cubre
    // `firmar`): cuerpo con caracteres no ASCII.
    expect(
      hmacSha256Hex(
        'golden-vector-secret-0123456789abcdef',
        '1790000000.{"loteId":"lote-golden-1","nombre":"Peña — 😀","facturas":[{"numeroFactura":"FV-1"}]}',
      ),
    ).toBe('8ed93fed4c6b1b779ff2295cdd3ff7a117736b3e53ec3550db27299a09d1c9cc');
  });

  it('devuelve siempre 64 caracteres hexadecimales en minúscula', () => {
    expect(hmacSha256Hex('k', '')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hmacHexEquals', () => {
  const FIRMA = hmacSha256Hex('Jefe', 'what do ya want for nothing?');

  it('true cuando ambas firmas son idénticas', () => {
    expect(hmacHexEquals(FIRMA, FIRMA)).toBe(true);
  });

  it('false cuando cambia un solo dígito', () => {
    const alterada = `${FIRMA.slice(0, 63)}${FIRMA.endsWith('0') ? '1' : '0'}`;

    expect(hmacHexEquals(FIRMA, alterada)).toBe(false);
  });

  it('false (sin lanzar) cuando el largo no coincide', () => {
    expect(hmacHexEquals(FIRMA, FIRMA.slice(0, 62))).toBe(false);
    expect(hmacHexEquals(FIRMA, `${FIRMA}00`)).toBe(false);
    expect(hmacHexEquals(FIRMA, '')).toBe(false);
  });

  it('false (sin lanzar) cuando no es hexadecimal', () => {
    expect(hmacHexEquals(FIRMA, 'z'.repeat(64))).toBe(false);
    expect(hmacHexEquals(FIRMA, 'g'.repeat(64))).toBe(false);
    expect(hmacHexEquals(FIRMA, ' '.repeat(64))).toBe(false);
  });

  it('false (sin lanzar) con entradas que no son cadenas', () => {
    expect(hmacHexEquals(FIRMA, undefined as unknown as string)).toBe(false);
    expect(hmacHexEquals(null as unknown as string, FIRMA)).toBe(false);
  });

  it('false cuando el esperado tampoco es una firma válida', () => {
    expect(hmacHexEquals('', '')).toBe(false);
    expect(hmacHexEquals('zz', 'zz')).toBe(false);
  });

  it('rechaza mayúsculas: la firma canónica es en minúscula', () => {
    expect(hmacHexEquals(FIRMA, FIRMA.toUpperCase())).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cadenaFirma, firmarComptable } from './comptable.firma';

const FIXTURES = join(
  __dirname,
  '..',
  '..',
  '..',
  'test',
  'fixtures',
  'comptable',
);

interface CasoVector {
  timestamp: string;
  metodo: string;
  ruta: string;
  rawBody: string;
  firma: string;
}

const vector = JSON.parse(
  readFileSync(join(FIXTURES, 'vector-firma.json'), 'utf8'),
) as { secreto: string; casos: CasoVector[] };

/** The vector's rawBody is the compact JSON.stringify of the shared payload. */
const rawBodyDelPayload = JSON.stringify(
  JSON.parse(readFileSync(join(FIXTURES, 'payload-v1.json'), 'utf8')),
);

describe('firma de Comptable', () => {
  it('arma la cadena timestamp.MÉTODO.ruta.cuerpo', () => {
    expect(
      cadenaFirma({
        timestamp: '1700000000',
        metodo: 'post',
        ruta: '/api/v1/x?simular=true',
        rawBody: '{"a":1}',
      }),
    ).toBe('1700000000.POST./api/v1/x?simular=true.{"a":1}');
  });

  it.each(vector.casos.map((c) => [c.metodo, c] as const))(
    'reproduce byte a byte el vector compartido con Comptable (%s)',
    (_metodo, caso) => {
      const rawBody = caso.rawBody === '' ? '' : rawBodyDelPayload;

      expect(
        firmarComptable(vector.secreto, {
          timestamp: caso.timestamp,
          metodo: caso.metodo,
          ruta: caso.ruta,
          rawBody,
        }),
      ).toBe(caso.firma);
    },
  );

  it('una firma no sirve para otra ruta ni para otro método', () => {
    const base = {
      timestamp: '1792512000',
      metodo: 'POST',
      ruta: '/api/v1/integraciones/websaco/empresas/1/lotes?simular=true',
      rawBody: '{}',
    };
    const firma = firmarComptable(vector.secreto, base);

    expect(
      firmarComptable(vector.secreto, {
        ...base,
        ruta: '/api/v1/integraciones/websaco/empresas/1/lotes?simular=false',
      }),
    ).not.toBe(firma);
    expect(
      firmarComptable(vector.secreto, { ...base, metodo: 'GET' }),
    ).not.toBe(firma);
  });
});

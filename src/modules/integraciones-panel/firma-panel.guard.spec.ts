import { Logger, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { hmacSha256Hex } from '../../common/utils/hmac';
import { FirmaPanelGuard } from './firma-panel.guard';
import { cadenaFirma } from './firma-panel';

const SECRET = 'panel-test-secret-0123456789abcdef-xyz';
const AHORA_SEGUNDOS = 1_790_000_000;
const RUTA = '/api/v1/integraciones/panel/registros?q=pinos';
const RUTA_PUT =
  '/api/v1/integraciones/panel/registros/670000000000000000000001/vinculo';
const CUERPO = '{"sistema":"comptable","registroId":"abc"}';

// Same vector the panel and the other systems pin (Comptable's golden file).
const VECTOR = {
  secret: 'comptable-test-secret-0123456789abcdef',
  timestamp: '1792512000',
  metodo: 'GET',
  ruta: '/api/v1/integraciones/websaco/empresas/670000000000000000000001',
  firma: 'f48ad5c95606dead9e4909f3b5f4e4008af197db804961cf07531c1d15d067a1',
};

interface Opciones {
  secret?: string;
  ts?: number;
  metodo?: string;
  cuerpo?: string;
}

/** Signs exactly as the panel does for the given request. */
const firmar = (ruta: string, o: Opciones = {}) => {
  const ts = String(o.ts ?? AHORA_SEGUNDOS);
  const firma = hmacSha256Hex(
    o.secret ?? SECRET,
    cadenaFirma({
      timestamp: ts,
      metodo: o.metodo ?? 'GET',
      ruta,
      rawBody: o.cuerpo ?? '',
    }),
  );
  return { ts, firma: `sha256=${firma}` };
};

const mockConfig = (secreto: unknown) => ({
  get: jest.fn((clave: string) =>
    clave === 'app.panelHmacSecret' ? secreto : undefined,
  ),
});

interface PeticionFalsa {
  headers: Record<string, string | string[] | undefined>;
  ruta?: string;
  metodo?: string;
  cuerpo?: string;
  rawHeaders?: string[];
}

const mockContext = ({
  headers,
  ruta = RUTA,
  metodo = 'GET',
  cuerpo,
  rawHeaders,
}: PeticionFalsa): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({
        headers,
        originalUrl: ruta,
        method: metodo,
        rawBody: cuerpo === undefined ? undefined : Buffer.from(cuerpo),
        rawHeaders,
      }),
    }),
  }) as unknown as ExecutionContext;

const contextoFirmado = (ruta = RUTA, o: Opciones = {}) => {
  const { ts, firma } = firmar(ruta, o);
  return mockContext({
    headers: { 'x-websaco-timestamp': ts, 'x-websaco-signature': firma },
    ruta,
    metodo: o.metodo ?? 'GET',
    cuerpo: o.cuerpo,
  });
};

describe('FirmaPanelGuard', () => {
  let warnSpy: jest.SpyInstance;
  let guard: FirmaPanelGuard;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Date, 'now').mockReturnValue(AHORA_SEGUNDOS * 1000 + 500);
    guard = new FirmaPanelGuard(mockConfig(SECRET) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('firma válida', () => {
    it('deja pasar un GET sin cuerpo correctamente firmado', () => {
      expect(guard.canActivate(contextoFirmado())).toBe(true);
    });

    it('deja pasar un PUT firmado sobre su cuerpo exacto', () => {
      expect(
        guard.canActivate(
          contextoFirmado(RUTA_PUT, { metodo: 'PUT', cuerpo: CUERPO }),
        ),
      ).toBe(true);
    });

    it('reproduce el vector compartido con el panel y los demás sistemas', () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_792_512_000_000);
      const g = new FirmaPanelGuard(mockConfig(VECTOR.secret) as never);

      expect(
        g.canActivate(
          mockContext({
            headers: {
              'x-websaco-timestamp': VECTOR.timestamp,
              'x-websaco-signature': `sha256=${VECTOR.firma}`,
            },
            ruta: VECTOR.ruta,
            metodo: VECTOR.metodo,
          }),
        ),
      ).toBe(true);
    });
  });

  describe('rechazos de firma', () => {
    it('secreto distinto', () => {
      expect(() =>
        guard.canActivate(
          contextoFirmado(RUTA, {
            secret: 'otro-secreto-de-32-caracteres-xxxxxx',
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('un solo dígito alterado', () => {
      const { ts, firma } = firmar(RUTA);
      const ultimo = firma.endsWith('0') ? '1' : '0';

      expect(() =>
        guard.canActivate(
          mockContext({
            headers: {
              'x-websaco-timestamp': ts,
              'x-websaco-signature': `${firma.slice(0, -1)}${ultimo}`,
            },
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('cuerpo alterado después de firmar', () => {
      const { ts, firma } = firmar(RUTA_PUT, { metodo: 'PUT', cuerpo: CUERPO });

      expect(() =>
        guard.canActivate(
          mockContext({
            headers: {
              'x-websaco-timestamp': ts,
              'x-websaco-signature': firma,
            },
            ruta: RUTA_PUT,
            metodo: 'PUT',
            cuerpo: CUERPO.replace('abc', 'abd'),
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('PUT con cuerpo firmado vacío pero cuerpo recibido con contenido', () => {
      const { ts, firma } = firmar(RUTA_PUT, { metodo: 'PUT' });

      expect(() =>
        guard.canActivate(
          mockContext({
            headers: {
              'x-websaco-timestamp': ts,
              'x-websaco-signature': firma,
            },
            ruta: RUTA_PUT,
            metodo: 'PUT',
            cuerpo: CUERPO,
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('ruta alterada (otro registro o query extra)', () => {
      const { ts, firma } = firmar(RUTA_PUT, { metodo: 'PUT', cuerpo: CUERPO });
      const headers = {
        'x-websaco-timestamp': ts,
        'x-websaco-signature': firma,
      };

      for (const ruta of [
        RUTA_PUT.replace('0001', '0002'),
        `${RUTA_PUT}?forzar=true`,
        RUTA_PUT.replace('/api/v1', ''),
      ]) {
        expect(() =>
          guard.canActivate(
            mockContext({ headers, ruta, metodo: 'PUT', cuerpo: CUERPO }),
          ),
        ).toThrow(UnauthorizedException);
      }
    });

    it('método alterado: firma de GET reutilizada con PUT', () => {
      const { ts, firma } = firmar(RUTA);

      expect(() =>
        guard.canActivate(
          mockContext({
            headers: {
              'x-websaco-timestamp': ts,
              'x-websaco-signature': firma,
            },
            metodo: 'PUT',
          }),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('headers', () => {
    const { ts, firma } = firmar(RUTA);

    it.each([
      ['sin timestamp', { 'x-websaco-signature': firma }],
      ['sin firma', { 'x-websaco-timestamp': ts }],
      ['sin ninguno', {}],
      [
        'timestamp duplicado (array)',
        { 'x-websaco-timestamp': [ts, ts], 'x-websaco-signature': firma },
      ],
      [
        'firma duplicada unida por coma, como la entrega Node',
        {
          'x-websaco-timestamp': ts,
          'x-websaco-signature': `${firma}, ${firma}`,
        },
      ],
      [
        'timestamp vacío',
        { 'x-websaco-timestamp': '', 'x-websaco-signature': firma },
      ],
      [
        'timestamp no numérico',
        { 'x-websaco-timestamp': 'abc', 'x-websaco-signature': firma },
      ],
      [
        'timestamp con signo',
        { 'x-websaco-timestamp': `+${ts}`, 'x-websaco-signature': firma },
      ],
      [
        'timestamp de más de 12 dígitos',
        {
          'x-websaco-timestamp': '1790000000000',
          'x-websaco-signature': firma,
        },
      ],
      [
        'firma sin el prefijo sha256=',
        {
          'x-websaco-timestamp': ts,
          'x-websaco-signature': firma.slice('sha256='.length),
        },
      ],
      [
        'firma en mayúscula',
        {
          'x-websaco-timestamp': ts,
          'x-websaco-signature': `sha256=${firma.slice(7).toUpperCase()}`,
        },
      ],
      [
        'firma de largo incorrecto',
        {
          'x-websaco-timestamp': ts,
          'x-websaco-signature': firma.slice(0, -2),
        },
      ],
      [
        'firma no hexadecimal',
        {
          'x-websaco-timestamp': ts,
          'x-websaco-signature': `sha256=${'z'.repeat(64)}`,
        },
      ],
    ] as Array<[string, Record<string, string | string[]>]>)(
      '%s: 401',
      (_nombre, headers) => {
        expect(() => guard.canActivate(mockContext({ headers }))).toThrow(
          UnauthorizedException,
        );
      },
    );

    it('un header repetido en el cable (rawHeaders): 401 aunque la firma sea válida', () => {
      expect(() =>
        guard.canActivate(
          mockContext({
            headers: {
              'x-websaco-timestamp': ts,
              'x-websaco-signature': firma,
            },
            rawHeaders: [
              'x-websaco-timestamp',
              ts,
              'X-Websaco-Timestamp',
              ts,
              'x-websaco-signature',
              firma,
            ],
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('una firma repetida en el cable (rawHeaders): 401', () => {
      expect(() =>
        guard.canActivate(
          mockContext({
            headers: {
              'x-websaco-timestamp': ts,
              'x-websaco-signature': firma,
            },
            rawHeaders: [
              'x-websaco-timestamp',
              ts,
              'x-websaco-signature',
              firma,
              'X-WEBSACO-SIGNATURE',
              firma,
            ],
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('cada header una sola vez en rawHeaders: pasa', () => {
      expect(
        guard.canActivate(
          mockContext({
            headers: {
              'x-websaco-timestamp': ts,
              'x-websaco-signature': firma,
            },
            rawHeaders: [
              'X-Websaco-Timestamp',
              ts,
              'X-Websaco-Signature',
              firma,
            ],
          }),
        ),
      ).toBe(true);
    });
  });

  describe('ventana de timestamp', () => {
    it.each([-300, 0, 300])('desfase de %i s: pasa', (delta) => {
      expect(
        guard.canActivate(
          contextoFirmado(RUTA, { ts: AHORA_SEGUNDOS + delta }),
        ),
      ).toBe(true);
    });

    it.each([-301, 301])('desfase de %i s: 401', (delta) => {
      expect(() =>
        guard.canActivate(
          contextoFirmado(RUTA, { ts: AHORA_SEGUNDOS + delta }),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('falla cerrado sin secreto', () => {
    it.each([
      ['sin definir', undefined],
      ['cadena vacía', ''],
      ['solo espacios', '   '],
      ['no es una cadena', 123],
    ])(
      'secreto %s: 401 aunque la petición esté bien firmada',
      (_n, secreto) => {
        const g = new FirmaPanelGuard(mockConfig(secreto) as never);

        expect(() => g.canActivate(contextoFirmado())).toThrow(
          UnauthorizedException,
        );
      },
    );

    it('sin secreto no lee los headers ni la URL de la petición', () => {
      const g = new FirmaPanelGuard(mockConfig(undefined) as never);
      const getRequest = jest.fn();
      const contexto = {
        switchToHttp: () => ({ getRequest }),
      } as unknown as ExecutionContext;

      expect(() => g.canActivate(contexto)).toThrow(UnauthorizedException);
      expect(getRequest).not.toHaveBeenCalled();
    });
  });

  describe('opacidad y logs', () => {
    it('todos los rechazos lanzan la misma 401 sin código ni mensaje propio', () => {
      const casos = [
        () =>
          new FirmaPanelGuard(mockConfig(undefined) as never).canActivate(
            contextoFirmado(),
          ),
        () => guard.canActivate(mockContext({ headers: {} })),
        () => guard.canActivate(contextoFirmado(RUTA, { ts: 1 })),
        () => guard.canActivate(contextoFirmado(RUTA, { secret: 'otro' })),
      ];

      const respuestas = casos.map((caso) => {
        try {
          caso();
          return null;
        } catch (e) {
          return (e as UnauthorizedException).getResponse();
        }
      });

      expect(new Set(respuestas.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(respuestas[0]).toEqual({
        statusCode: 401,
        message: 'Unauthorized',
      });
    });

    it('nunca loguea secreto, firma, timestamp ni URL', () => {
      const { ts, firma } = firmar(RUTA, { secret: 'otro-secreto' });
      const contextos = [
        mockContext({
          headers: { 'x-websaco-timestamp': ts, 'x-websaco-signature': firma },
        }),
        mockContext({
          headers: {
            'x-websaco-timestamp': 'valor-raro-1234',
            'x-websaco-signature': 'sha256=firma-rara',
          },
        }),
        mockContext({ headers: {} }),
      ];
      for (const contexto of contextos) {
        expect(() => guard.canActivate(contexto)).toThrow(
          UnauthorizedException,
        );
      }

      const mensajes = warnSpy.mock.calls.flat().map(String);
      expect(mensajes.length).toBe(contextos.length);
      for (const mensaje of mensajes) {
        expect(mensaje).not.toContain(SECRET);
        expect(mensaje).not.toContain('otro-secreto');
        expect(mensaje).not.toContain(firma);
        expect(mensaje).not.toContain(firma.slice(7));
        expect(mensaje).not.toContain('valor-raro-1234');
        expect(mensaje).not.toContain('firma-rara');
        expect(mensaje).not.toContain(RUTA);
        expect(mensaje).not.toContain('pinos');
      }
    });
  });
});

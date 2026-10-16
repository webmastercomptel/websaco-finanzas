import { Logger, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { hmacSha256Hex } from '../../common/utils/hmac';
import { firmar } from '../publicacion-facturas/publicacion-facturas.firma';
import { FirmaWebsaco3Guard } from './firma-websaco3.guard';
import { cadenaFirmaPropietarios, rutaYConsulta } from './propietarios.firma';
import { VECTOR_COMPARTIDO } from './propietarios.vector';

const SECRET = VECTOR_COMPARTIDO.secret;
const AHORA_SEGUNDOS = 1_790_000_000;
const PATH = VECTOR_COMPARTIDO.path;
const ID = '507f1f77bcf86cd799439011';
const URL_VALIDA = `${PATH}?websaco3CopropiedadId=${ID}`;

/** Signs exactly as the WebSaco3 client would, for a given received URL. */
const firmarUrl = (
  url: string,
  opciones: { secret?: string; ts?: number; method?: string } = {},
) => {
  const ts = String(opciones.ts ?? AHORA_SEGUNDOS);
  const { path, rawQuery } = rutaYConsulta(url);
  const firma = hmacSha256Hex(
    opciones.secret ?? SECRET,
    cadenaFirmaPropietarios({
      timestamp: ts,
      method: opciones.method ?? 'GET',
      path,
      rawQuery,
    }),
  );
  return { ts, firma: `sha256=${firma}` };
};

const mockConfig = (secreto: unknown) => ({
  get: jest.fn((clave: string) =>
    clave === 'app.websaco3HmacSecret' ? secreto : undefined,
  ),
});

const mockContext = (
  headers: Record<string, string | string[] | undefined>,
  url = URL_VALIDA,
  method = 'GET',
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers, originalUrl: url, method }),
    }),
  }) as unknown as ExecutionContext;

/** A fully valid request for `url`, optionally overriding pieces. */
const contextoFirmado = (
  url = URL_VALIDA,
  opciones: { secret?: string; ts?: number; method?: string } = {},
) => {
  const { ts, firma } = firmarUrl(url, opciones);
  return mockContext(
    { 'x-websaco-timestamp': ts, 'x-websaco-signature': firma },
    url,
    opciones.method ?? 'GET',
  );
};

describe('FirmaWebsaco3Guard', () => {
  let warnSpy: jest.SpyInstance;
  let guard: FirmaWebsaco3Guard;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Date, 'now').mockReturnValue(AHORA_SEGUNDOS * 1000 + 500);
    guard = new FirmaWebsaco3Guard(mockConfig(SECRET) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('firma válida', () => {
    it('deja pasar una petición correctamente firmada', () => {
      expect(guard.canActivate(contextoFirmado())).toBe(true);
    });

    it('acepta el id en mayúscula firmado tal cual se envió', () => {
      const url = `${PATH}?websaco3CopropiedadId=${ID.toUpperCase()}`;

      expect(guard.canActivate(contextoFirmado(url))).toBe(true);
    });

    it('no depende del orden de los parámetros de la query', () => {
      const firmada = firmarUrl(`${PATH}?a=1&b=2`);
      const contexto = mockContext(
        {
          'x-websaco-timestamp': firmada.ts,
          'x-websaco-signature': firmada.firma,
        },
        `${PATH}?b=2&a=1`,
      );

      expect(guard.canActivate(contexto)).toBe(true);
    });

    it('verifica el vector compartido con WebSaco3', () => {
      for (const caso of VECTOR_COMPARTIDO.casos) {
        const url = caso.rawQuery
          ? `${VECTOR_COMPARTIDO.path}?${caso.rawQuery}`
          : VECTOR_COMPARTIDO.path;
        jest.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
        const g = new FirmaWebsaco3Guard(
          mockConfig(VECTOR_COMPARTIDO.secret) as never,
        );

        expect(
          g.canActivate(
            mockContext(
              {
                'x-websaco-timestamp': VECTOR_COMPARTIDO.timestamp,
                'x-websaco-signature': caso.firma,
              },
              url,
            ),
          ),
        ).toBe(true);
      }
    });
  });

  describe('rechazos de firma', () => {
    it('secreto distinto', () => {
      expect(() =>
        guard.canActivate(
          contextoFirmado(URL_VALIDA, {
            secret: 'otro-secreto-de-32-caracteres-xxxxxx',
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('un solo dígito alterado', () => {
      const { ts, firma } = firmarUrl(URL_VALIDA);
      const ultimo = firma.endsWith('0') ? '1' : '0';
      const alterada = `${firma.slice(0, -1)}${ultimo}`;

      expect(() =>
        guard.canActivate(
          mockContext({
            'x-websaco-timestamp': ts,
            'x-websaco-signature': alterada,
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('firma reutilizada en otro id (o con un parámetro extra)', () => {
      const { ts, firma } = firmarUrl(URL_VALIDA);
      const headers = {
        'x-websaco-timestamp': ts,
        'x-websaco-signature': firma,
      };

      expect(() =>
        guard.canActivate(
          mockContext(
            headers,
            `${PATH}?websaco3CopropiedadId=${'a'.repeat(24)}`,
          ),
        ),
      ).toThrow(UnauthorizedException);
      expect(() =>
        guard.canActivate(mockContext(headers, `${URL_VALIDA}&extra=1`)),
      ).toThrow(UnauthorizedException);
    });

    it('firma reutilizada con barra final', () => {
      const { ts, firma } = firmarUrl(URL_VALIDA);
      const url = `${PATH}/?websaco3CopropiedadId=${ID}`;

      expect(() =>
        guard.canActivate(
          mockContext(
            { 'x-websaco-timestamp': ts, 'x-websaco-signature': firma },
            url,
          ),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('firma de un GET reutilizada con HEAD', () => {
      const { ts, firma } = firmarUrl(URL_VALIDA);

      expect(() =>
        guard.canActivate(
          mockContext(
            { 'x-websaco-timestamp': ts, 'x-websaco-signature': firma },
            URL_VALIDA,
            'HEAD',
          ),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('firma sin el prefijo /api/v1 en la ruta', () => {
      const firmada = firmarUrl(
        `/integraciones/websaco3/propietarios?websaco3CopropiedadId=${ID}`,
      );

      expect(() =>
        guard.canActivate(
          mockContext({
            'x-websaco-timestamp': firmada.ts,
            'x-websaco-signature': firmada.firma,
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('firma del esquema de publicación de facturas (`${ts}.${cuerpo}`)', () => {
      const ts = String(AHORA_SEGUNDOS);
      const firmaFacturas = `sha256=${firmar(SECRET, ts, '')}`;

      expect(() =>
        guard.canActivate(
          mockContext({
            'x-websaco-timestamp': ts,
            'x-websaco-signature': firmaFacturas,
          }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('firma con otro prefijo de propósito', () => {
      const ts = String(AHORA_SEGUNDOS);
      const { path, rawQuery } = rutaYConsulta(URL_VALIDA);
      const cadena = cadenaFirmaPropietarios({
        timestamp: ts,
        method: 'GET',
        path,
        rawQuery,
      }).replace('propietarios.v1', 'otro.v1');

      expect(() =>
        guard.canActivate(
          mockContext({
            'x-websaco-timestamp': ts,
            'x-websaco-signature': `sha256=${hmacSha256Hex(SECRET, cadena)}`,
          }),
        ),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('headers', () => {
    const { ts, firma } = firmarUrl(URL_VALIDA);

    it.each([
      ['sin timestamp', { 'x-websaco-signature': firma }],
      ['sin firma', { 'x-websaco-timestamp': ts }],
      ['sin ninguno', {}],
      [
        'timestamp duplicado (array)',
        { 'x-websaco-timestamp': [ts, ts], 'x-websaco-signature': firma },
      ],
      [
        'firma duplicada (array)',
        { 'x-websaco-timestamp': ts, 'x-websaco-signature': [firma, firma] },
      ],
      [
        'firma duplicada unida por coma, como la entrega Node',
        {
          'x-websaco-timestamp': ts,
          'x-websaco-signature': `${firma}, ${firma}`,
        },
      ],
      [
        'timestamp duplicado unido por coma, como la entrega Node',
        { 'x-websaco-timestamp': `${ts}, ${ts}`, 'x-websaco-signature': firma },
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
        'timestamp decimal',
        { 'x-websaco-timestamp': `${ts}.5`, 'x-websaco-signature': firma },
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
        expect(() => guard.canActivate(mockContext(headers))).toThrow(
          UnauthorizedException,
        );
      },
    );
  });

  describe('ventana de timestamp', () => {
    it.each([-300, 0, 300])('desfase de %i s: pasa', (delta) => {
      expect(
        guard.canActivate(
          contextoFirmado(URL_VALIDA, { ts: AHORA_SEGUNDOS + delta }),
        ),
      ).toBe(true);
    });

    it.each([-301, 301])('desfase de %i s: 401', (delta) => {
      expect(() =>
        guard.canActivate(
          contextoFirmado(URL_VALIDA, { ts: AHORA_SEGUNDOS + delta }),
        ),
      ).toThrow(UnauthorizedException);
    });

    it('la ventana se mide en segundos enteros, sin redondear a favor', () => {
      // 299.999 s de adelanto en milisegundos: floor(now) sigue dentro.
      jest.spyOn(Date, 'now').mockReturnValue(AHORA_SEGUNDOS * 1000 + 999);

      expect(
        guard.canActivate(
          contextoFirmado(URL_VALIDA, { ts: AHORA_SEGUNDOS + 300 }),
        ),
      ).toBe(true);
      expect(() =>
        guard.canActivate(
          contextoFirmado(URL_VALIDA, { ts: AHORA_SEGUNDOS + 301 }),
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
        const g = new FirmaWebsaco3Guard(mockConfig(secreto) as never);

        expect(() => g.canActivate(contextoFirmado())).toThrow(
          UnauthorizedException,
        );
      },
    );

    it('sin secreto no lee los headers ni la URL de la petición', () => {
      const g = new FirmaWebsaco3Guard(mockConfig(undefined) as never);
      const getRequest = jest.fn();
      const contexto = {
        switchToHttp: () => ({ getRequest }),
      } as unknown as ExecutionContext;

      expect(() => g.canActivate(contexto)).toThrow(UnauthorizedException);
      expect(getRequest).not.toHaveBeenCalled();
    });

    it('un secreto firmado con una cadena vacía como clave no pasa', () => {
      const g = new FirmaWebsaco3Guard(mockConfig('') as never);

      expect(() =>
        g.canActivate(contextoFirmado(URL_VALIDA, { secret: '' })),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('opacidad y logs', () => {
    it('todos los rechazos lanzan la misma 401 sin mensaje propio', () => {
      const casos = [
        () =>
          new FirmaWebsaco3Guard(mockConfig(undefined) as never).canActivate(
            contextoFirmado(),
          ),
        () => guard.canActivate(mockContext({})),
        () => guard.canActivate(contextoFirmado(URL_VALIDA, { ts: 1 })),
        () =>
          guard.canActivate(contextoFirmado(URL_VALIDA, { secret: 'otro' })),
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
      const { ts, firma } = firmarUrl(URL_VALIDA, { secret: 'otro-secreto' });
      const contextos = [
        mockContext({
          'x-websaco-timestamp': ts,
          'x-websaco-signature': firma,
        }),
        mockContext({
          'x-websaco-timestamp': 'valor-raro-1234',
          'x-websaco-signature': 'sha256=firma-rara',
        }),
        mockContext({}),
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
        expect(mensaje).not.toContain(ID);
        expect(mensaje).not.toContain(PATH);
      }
    });
  });
});

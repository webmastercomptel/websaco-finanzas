/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument --
   the fixtures are deliberately loose event shapes (Sentry's own types are
   too strict to build partial, hostile events) and the assertions inspect
   them structurally. */
import * as Sentry from '@sentry/node';
import {
  limpiarBreadcrumb,
  limpiarEvento,
  iniciarSentry,
} from './iniciar-sentry';

jest.mock('@sentry/node', () => ({
  init: jest.fn(),
  httpIntegration: jest.fn((opciones: unknown) => ({
    name: 'Http',
    opciones,
  })),
}));

const DSN = 'https://clave@o1.ingest.sentry.io/2';

/** The options `iniciarSentry` actually handed to `Sentry.init`. */
function opcionesConfiguradas(): Record<string, any> {
  iniciarSentry({ dsn: DSN, env: 'production', release: 'rev-7' });
  return (Sentry.init as jest.Mock).mock.calls[0][0] as Record<string, any>;
}

/** What `httpServerIntegration` leaves on an event for a failed request. */
function eventoConPeticion(): Record<string, any> {
  return {
    message: 'boom',
    exception: { values: [{ type: 'Error', value: 'boom' }] },
    request: {
      method: 'PATCH',
      url: 'http://api.ejemplo.com/api/v1/usuarios/1?token=xyz&page=2',
      query_string: 'token=xyz&page=2',
      data: '{"nuevaPassword":"Hunter2!"}',
      cookies: { session: 'cookie-secreta' },
      env: { REMOTE_ADDR: '10.0.0.9' },
      headers: {
        host: 'api.ejemplo.com',
        'user-agent': 'jest',
        'content-type': 'application/json',
        'x-coproperty-id': 'cop-1',
        authorization: 'Bearer abc',
        cookie: 'sid=cookie-secreta',
        'set-cookie': 'sid=otra',
        'x-api-key': 'clave-api',
        'x-signature': 'firma-hmac',
        'x-hub-signature-256': 'sha256=firma',
        'x-refresh-token': 'refresh',
        'x-client-secret': 'secreto',
        'x-algo-raro': 'valor',
      },
    },
    user: { id: 'uid-1', email: 'a@b.co', ip_address: '1.2.3.4' },
    breadcrumbs: [
      {
        category: 'http',
        data: {
          url: 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIza123&alt=json',
          method: 'POST',
          request_body: '{"idToken":"abc"}',
          request_headers: { authorization: 'Bearer abc' },
        },
      },
      { category: 'console', message: 'hola' },
    ],
  };
}

describe('iniciarSentry', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sin DSN no inicia nada', () => {
    expect(iniciarSentry({ dsn: undefined, env: 'production' })).toBe(false);
    expect(iniciarSentry({ dsn: '', env: 'production' })).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('con DSN inicia con el entorno, sin datos personales y sin trazas', () => {
    expect(
      iniciarSentry({ dsn: DSN, env: 'production', release: 'rev-7' }),
    ).toBe(true);

    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: DSN,
        environment: 'production',
        release: 'rev-7',
        sendDefaultPii: false,
        tracesSampleRate: 0,
      }),
    );
  });

  it('apaga la captura del cuerpo de las peticiones entrantes en la integración HTTP', () => {
    const opciones = opcionesConfiguradas();
    const defaults = [{ name: 'Http' }, { name: 'Console' }];

    const integraciones = (
      opciones.integrations as (d: { name: string }[]) => unknown[]
    )(defaults);

    expect(Sentry.httpIntegration).toHaveBeenCalledWith({
      maxIncomingRequestBodySize: 'none',
    });
    expect(integraciones).toEqual([
      { name: 'Console' },
      { name: 'Http', opciones: { maxIncomingRequestBodySize: 'none' } },
    ]);
  });

  it('el beforeSend configurado limpia el evento: nada sensible sobrevive y el resto se conserva', () => {
    const { beforeSend } = opcionesConfiguradas();

    const salida = beforeSend(eventoConPeticion(), {}) as Record<string, any>;
    const texto = JSON.stringify(salida);

    for (const secreto of [
      'Hunter2!',
      'nuevaPassword',
      'Bearer abc',
      'cookie-secreta',
      'clave-api',
      'firma-hmac',
      'sha256=firma',
      'refresh',
      'secreto',
      'xyz',
      'AIza123',
      '10.0.0.9',
      '1.2.3.4',
      'a@b.co',
    ]) {
      expect(texto).not.toContain(secreto);
    }
    expect(salida.request).toMatchObject({
      method: 'PATCH',
      headers: {
        host: 'api.ejemplo.com',
        'user-agent': 'jest',
        'content-type': 'application/json',
        'x-coproperty-id': 'cop-1',
      },
    });
    expect(salida.request.url).toBe(
      'http://api.ejemplo.com/api/v1/usuarios/1?token=[Filtered]&page=2',
    );
    expect(salida.exception.values[0].value).toBe('boom');
    expect(salida.user).toEqual({ id: 'uid-1' });
  });

  it('beforeSendTransaction y beforeBreadcrumb usan la misma limpieza', () => {
    const opciones = opcionesConfiguradas();

    const transaccion = opciones.beforeSendTransaction(
      eventoConPeticion(),
      {},
    ) as Record<string, any>;
    const crumb = opciones.beforeBreadcrumb(
      eventoConPeticion().breadcrumbs[0],
      {},
    ) as Record<string, any>;

    expect(JSON.stringify(transaccion)).not.toContain('Hunter2!');
    expect(transaccion.request.headers.authorization).toBeUndefined();
    expect(JSON.stringify(crumb)).not.toContain('AIza123');
    expect(JSON.stringify(crumb)).not.toContain('idToken');
  });
});

describe('limpiarEvento', () => {
  it('quita el cuerpo, las cookies, los headers fuera de la lista blanca y el query sensible', () => {
    const salida = limpiarEvento(eventoConPeticion() as never) as Record<
      string,
      any
    >;

    expect(salida.request.data).toBeUndefined();
    expect(salida.request.cookies).toBeUndefined();
    expect(salida.request.env).toBeUndefined();
    expect(Object.keys(salida.request.headers).sort()).toEqual([
      'content-type',
      'host',
      'user-agent',
      'x-coproperty-id',
    ]);
    expect(salida.request.query_string).toBe('token=[Filtered]&page=2');
    expect(salida.request.method).toBe('PATCH');
  });

  it('acepta el query como objeto y filtra solo las claves sensibles', () => {
    const salida = limpiarEvento({
      request: {
        url: '/api/v1/inmuebles',
        query_string: { access_token: 'a', password: 'b', buscar: 'torre' },
      },
    } as never) as Record<string, any>;

    expect(salida.request.query_string).toEqual({
      access_token: '[Filtered]',
      password: '[Filtered]',
      buscar: 'torre',
    });
    expect(salida.request.url).toBe('/api/v1/inmuebles');
  });

  it('no falla con un evento sin petición, sin usuario ni breadcrumbs', () => {
    expect(limpiarEvento({ message: 'x' } as never)).toEqual({ message: 'x' });
  });

  it('limpia las URL de los spans de una transacción', () => {
    const salida = limpiarEvento({
      type: 'transaction',
      spans: [
        { data: { 'http.url': 'https://x.co/p?token=abc&a=1', otro: 'ok' } },
      ],
    } as never) as Record<string, any>;

    expect(JSON.stringify(salida)).not.toContain('abc');
    expect(salida.spans[0].data.otro).toBe('ok');
  });
});

describe('limpiarBreadcrumb', () => {
  it('deja intactos los breadcrumbs que no son HTTP', () => {
    const crumb = { category: 'console', message: 'hola' };
    expect(limpiarBreadcrumb(crumb as never)).toEqual(crumb);
  });
});

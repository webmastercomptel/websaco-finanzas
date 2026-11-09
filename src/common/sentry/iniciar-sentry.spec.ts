import * as Sentry from '@sentry/node';
import { iniciarSentry } from './iniciar-sentry';

jest.mock('@sentry/node', () => ({ init: jest.fn() }));

describe('iniciarSentry', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sin DSN no inicia nada', () => {
    expect(iniciarSentry({ dsn: undefined, env: 'production' })).toBe(false);
    expect(iniciarSentry({ dsn: '', env: 'production' })).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('con DSN inicia con el entorno, sin datos personales y sin trazas', () => {
    const dsn = 'https://clave@o1.ingest.sentry.io/2';

    expect(iniciarSentry({ dsn, env: 'production', release: 'rev-7' })).toBe(
      true,
    );

    expect(Sentry.init).toHaveBeenCalledWith({
      dsn,
      environment: 'production',
      release: 'rev-7',
      sendDefaultPii: false,
      tracesSampleRate: 0,
    });
  });
});

import { envValidationSchema } from './env.validation';

/** Minimum set of variables a valid environment always carries. */
const baseEnv = {
  MONGODB_URI:
    'mongodb+srv://usuario:clave@cluster0.abcde.mongodb.net/finanzas',
  REDIS_URL: 'rediss://default:clave@algo.redis-cloud.com:6379',
  FIREBASE_SERVICE_ACCOUNT_BASE64: 'eyJmYWtlIjoidmFsb3IifQ==',
  FIREBASE_STORAGE_BUCKET: 'finanzas-demo.appspot.com',
  ROOT_ADMIN_EMAIL: 'santiago@comptel.com',
};

const validate = (env: Record<string, unknown>) =>
  envValidationSchema.validate({ ...baseEnv, ...env });

/** Same environment minus one key, to prove that key is required. */
const withoutKey = (key: keyof typeof baseEnv) => {
  const copy: Record<string, unknown> = { ...baseEnv };
  delete copy[key];
  return envValidationSchema.validate(copy);
};

describe('envValidationSchema', () => {
  it('acepta un entorno de desarrollo mínimo', () => {
    const { error } = validate({ NODE_ENV: 'development' });

    expect(error).toBeUndefined();
  });

  it('acepta también un entorno de producción', () => {
    const { error } = validate({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://finanzas.ejemplo.com',
    });

    expect(error).toBeUndefined();
  });

  describe('CORS_ORIGINS', () => {
    it('es obligatoria en producción', () => {
      // Una API que le contesta a cualquier origen deja que una página que la
      // persona nunca visitó lea respuestas en su nombre.
      const { error } = validate({ NODE_ENV: 'production' });

      expect(error?.message).toContain('CORS_ORIGINS');
    });

    it('puede ir vacía en desarrollo', () => {
      const { error } = validate({ NODE_ENV: 'development', CORS_ORIGINS: '' });

      expect(error).toBeUndefined();
    });
  });

  describe('cadenas de conexión', () => {
    it('exige la de Mongo', () => {
      expect(withoutKey('MONGODB_URI').error?.message).toContain('MONGODB_URI');
    });

    it('exige la de Redis', () => {
      expect(withoutKey('REDIS_URL').error?.message).toContain('REDIS_URL');
    });

    it('acepta mongodb:// además de mongodb+srv://', () => {
      const { error } = validate({
        MONGODB_URI: 'mongodb://localhost:27017/finanzas',
      });

      expect(error).toBeUndefined();
    });

    it('acepta la cadena legacy multi-host de Atlas', () => {
      // The non-SRV string Atlas offers under "Connect" lists every replica
      // set member, comma-separated. This is NOT a valid RFC 3986 URI — a port
      // must be digits only — so a strict URI check rejects a string the
      // driver accepts. Validation must not be stricter than the driver.
      const { error } = validate({
        MONGODB_URI:
          'mongodb://usuario:clave@a-shard-00-00.abcde.mongodb.net:27017,' +
          'a-shard-00-01.abcde.mongodb.net:27017,' +
          'a-shard-00-02.abcde.mongodb.net:27017/' +
          '?ssl=true&replicaSet=atlas-shard-0&authSource=admin',
      });

      expect(error).toBeUndefined();
    });

    it('acepta rediss:// (TLS) además de redis://', () => {
      const { error } = validate({ REDIS_URL: 'redis://localhost:6379' });

      expect(error).toBeUndefined();
    });

    it('acepta una contraseña de Redis con caracteres estructurales', () => {
      // Same trap as the Atlas string above, from the other direction: a
      // generated password may contain `#` or `/`, which a strict URI parser
      // treats as structure. ioredis parses these; validation must not be
      // stricter than the client. And whoever hits it cannot fix it by reading
      // the message, because the password is not theirs to choose.
      for (const password of ['pa#ss', 'pa/ss', 'pa+ss=', 'p@ss']) {
        const { error } = validate({
          REDIS_URL: `rediss://default:${password}@algo.redis-cloud.com:6379`,
        });

        expect(error).toBeUndefined();
      }
    });

    it('rechaza una URI de Mongo con un esquema que no corresponde', () => {
      // Pegar la URL del panel web en vez de la cadena de conexión es el error
      // más fácil de cometer, y el mensaje tiene que decir qué se esperaba.
      const { error } = validate({
        MONGODB_URI: 'https://cloud.mongodb.com/v2/algo',
      });

      expect(error?.message).toContain('mongodb+srv://');
    });

    it('rechaza una URL de Redis con un esquema que no corresponde', () => {
      const { error } = validate({ REDIS_URL: 'https://redis.io/algo' });

      expect(error?.message).toContain('rediss://');
    });

    it('rechaza texto suelto que no es una cadena de conexión', () => {
      const { error } = validate({ MONGODB_URI: 'pegar-aca-la-cadena' });

      expect(error?.message).toContain('MONGODB_URI');
    });
  });

  describe('integración con Comptable', () => {
    const URL = 'https://comptable.ejemplo.com/api/v1';
    const SECRETO = 'comptable-secreto-compartido-de-32-caracteres';

    it('arranca sin ninguna de las dos', () => {
      expect(validate({}).error).toBeUndefined();
    });

    it('arranca con las dos juntas', () => {
      const { error } = validate({
        COMPTABLE_API_URL: URL,
        COMPTABLE_HMAC_SECRET: SECRETO,
      });

      expect(error).toBeUndefined();
    });

    it('rechaza la URL sin el secreto', () => {
      const { error } = validate({ COMPTABLE_API_URL: URL });

      expect(error?.message).toContain('COMPTABLE_HMAC_SECRET');
    });

    it('rechaza el secreto sin la URL', () => {
      const { error } = validate({ COMPTABLE_HMAC_SECRET: SECRETO });

      expect(error?.message).toContain('COMPTABLE_API_URL');
    });

    it('exige un secreto de al menos 32 caracteres', () => {
      const { error } = validate({
        COMPTABLE_API_URL: URL,
        COMPTABLE_HMAC_SECRET: 'corto',
      });

      expect(error?.message).toContain('COMPTABLE_HMAC_SECRET');
    });

    it('exige https en producción', () => {
      const { error } = validate({
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://finanzas.ejemplo.com',
        COMPTABLE_API_URL: 'http://comptable.ejemplo.com/api/v1',
        COMPTABLE_HMAC_SECRET: SECRETO,
      });

      expect(error?.message).toContain('COMPTABLE_API_URL');
    });
  });

  describe('FRONTEND_URL', () => {
    it('es opcional', () => {
      expect(validate({}).error).toBeUndefined();
    });

    it('acepta http en desarrollo', () => {
      expect(
        validate({ FRONTEND_URL: 'http://localhost:5173' }).error,
      ).toBeUndefined();
    });

    it('exige https en producción', () => {
      const produccion = {
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://finanzas.ejemplo.com',
      };

      expect(
        validate({ ...produccion, FRONTEND_URL: 'https://app.ejemplo.com' })
          .error,
      ).toBeUndefined();
      expect(
        validate({ ...produccion, FRONTEND_URL: 'http://app.ejemplo.com' })
          .error?.message,
      ).toContain('FRONTEND_URL');
    });
  });

  describe('correo (SendGrid)', () => {
    const CLAVE = 'SG.clave-de-prueba';
    const REMITENTE = 'notificaciones@ejemplo.com';

    it('arranca sin correo configurado', () => {
      expect(validate({}).error).toBeUndefined();
    });

    it('arranca con la clave y el remitente juntos, y el nombre es opcional', () => {
      const { error, value } = validate({
        SENDGRID_API_KEY: CLAVE,
        SENDGRID_FROM_EMAIL: REMITENTE,
      }) as { error?: Error; value: Record<string, unknown> };

      expect(error).toBeUndefined();
      expect(value.SENDGRID_FROM_NAME).toBe('WebSaco');
    });

    it('rechaza la clave sin el remitente', () => {
      const { error } = validate({ SENDGRID_API_KEY: CLAVE });

      expect(error?.message).toContain('SENDGRID_FROM_EMAIL');
    });

    it('rechaza el remitente sin la clave', () => {
      const { error } = validate({ SENDGRID_FROM_EMAIL: REMITENTE });

      expect(error?.message).toContain('SENDGRID_API_KEY');
    });

    it('rechaza un remitente que no es un correo', () => {
      const { error } = validate({
        SENDGRID_API_KEY: CLAVE,
        SENDGRID_FROM_EMAIL: 'no-es-un-correo',
      });

      expect(error?.message).toContain('SENDGRID_FROM_EMAIL');
    });
  });

  describe('panel de integraciones', () => {
    const SECRETO = 'panel-secreto-compartido-de-32-caracteres-x';

    it('arranca sin ninguna de las dos', () => {
      expect(validate({}).error).toBeUndefined();
    });

    it('el interruptor apagado no exige el secreto', () => {
      expect(
        validate({ INTEGRACION_PANEL_HABILITADA: 'false' }).error,
      ).toBeUndefined();
    });

    it('el interruptor encendido sin secreto falla nombrando la variable', () => {
      const { error } = validate({ INTEGRACION_PANEL_HABILITADA: 'true' });

      expect(error?.message).toContain('PANEL_HMAC_SECRET');
    });

    it('el interruptor encendido con secreto arranca', () => {
      const { error } = validate({
        INTEGRACION_PANEL_HABILITADA: 'true',
        PANEL_HMAC_SECRET: SECRETO,
      });

      expect(error).toBeUndefined();
    });

    it('el secreto solo (interruptor apagado por defecto) es válido', () => {
      expect(validate({ PANEL_HMAC_SECRET: SECRETO }).error).toBeUndefined();
    });

    it('un secreto de 31 caracteres falla', () => {
      const { error } = validate({ PANEL_HMAC_SECRET: 'x'.repeat(31) });

      expect(error?.message).toContain('PANEL_HMAC_SECRET');
    });

    it('un secreto vacío cuenta como ausente', () => {
      expect(validate({ PANEL_HMAC_SECRET: '' }).error).toBeUndefined();
      expect(
        validate({
          INTEGRACION_PANEL_HABILITADA: 'true',
          PANEL_HMAC_SECRET: '',
        }).error?.message,
      ).toContain('PANEL_HMAC_SECRET');
    });

    it('el secreto del panel no puede ser el de Comptable', () => {
      const { error } = validate({
        COMPTABLE_API_URL: 'https://comptable.ejemplo.com/api/v1',
        COMPTABLE_HMAC_SECRET: SECRETO,
        PANEL_HMAC_SECRET: SECRETO,
      });

      expect(error?.message).toContain('PANEL_HMAC_SECRET');
    });

    it('apagado por defecto', () => {
      const value = validate({}).value as Record<string, unknown>;

      expect(value.INTEGRACION_PANEL_HABILITADA).toBe(false);
    });
  });

  describe('credenciales de Firebase', () => {
    it('exige la credencial de servicio', () => {
      // No existe un modo "sin autenticación": si falta, no arranca.
      expect(
        withoutKey('FIREBASE_SERVICE_ACCOUNT_BASE64').error?.message,
      ).toContain('FIREBASE_SERVICE_ACCOUNT_BASE64');
    });

    it('exige el email del administrador raíz', () => {
      // Sin dirección raíz nadie puede operar la API, y un valor por defecto
      // sería una cuenta de administrador que no es de nadie.
      expect(withoutKey('ROOT_ADMIN_EMAIL').error?.message).toContain(
        'ROOT_ADMIN_EMAIL',
      );
    });

    it('rechaza un email raíz mal formado', () => {
      const { error } = validate({ ROOT_ADMIN_EMAIL: 'no-es-un-email' });

      expect(error?.message).toContain('ROOT_ADMIN_EMAIL');
    });
  });
});

describe('envValidationSchema — TRUST_PROXY_HOPS', () => {
  it('vale 1 por defecto (Cloud Run: un salto, el frente de Google)', () => {
    const resultado = validate({});
    expect(resultado.error).toBeUndefined();
    const valor = resultado.value as { TRUST_PROXY_HOPS: number };
    expect(valor.TRUST_PROXY_HOPS).toBe(1);
  });

  it('acepta un entero chico y rechaza "true" o negativos (nunca confiar en todo)', () => {
    expect(validate({ TRUST_PROXY_HOPS: '2' }).error).toBeUndefined();
    expect(validate({ TRUST_PROXY_HOPS: '0' }).error).toBeUndefined();
    expect(validate({ TRUST_PROXY_HOPS: 'true' }).error).toBeDefined();
    expect(validate({ TRUST_PROXY_HOPS: '-1' }).error).toBeDefined();
    expect(validate({ TRUST_PROXY_HOPS: '10' }).error).toBeDefined();
  });
});

describe('APP_ROLE', () => {
  it('por defecto es all: un despliegue que no lo conoce se comporta como antes', () => {
    const resultado = validate({});

    expect(resultado.error).toBeUndefined();
    expect((resultado.value as { APP_ROLE: string }).APP_ROLE).toBe('all');
  });

  it.each(['all', 'api', 'worker'])('acepta %s', (rol) => {
    expect(validate({ APP_ROLE: rol }).error).toBeUndefined();
  });

  it('rechaza un rol desconocido, nombrando la variable', () => {
    expect(validate({ APP_ROLE: 'workers' }).error?.message).toContain(
      'APP_ROLE',
    );
  });
});

describe('SENTRY_DSN', () => {
  it('es opcional: sin ella no se reporta nada', () => {
    expect(validate({}).error).toBeUndefined();
  });

  it('un valor vacío cuenta como ausente', () => {
    expect(validate({ SENTRY_DSN: '' }).error).toBeUndefined();
  });

  it('acepta un DSN https', () => {
    expect(
      validate({ SENTRY_DSN: 'https://clave@o123.ingest.sentry.io/456' }).error,
    ).toBeUndefined();
  });

  it('rechaza algo que no es una URL https', () => {
    expect(validate({ SENTRY_DSN: 'no-es-un-dsn' }).error?.message).toContain(
      'SENTRY_DSN',
    );
    expect(
      validate({ SENTRY_DSN: 'http://clave@sentry.local/1' }).error?.message,
    ).toContain('SENTRY_DSN');
  });
});

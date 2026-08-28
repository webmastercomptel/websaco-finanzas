import { envValidationSchema } from './env.validation';

/** Minimum set of variables a valid environment always carries. */
const baseEnv = {
  MONGODB_URI:
    'mongodb+srv://usuario:clave@cluster0.abcde.mongodb.net/finanzas',
  REDIS_URL: 'rediss://default:clave@algo.redis-cloud.com:6379',
  FIREBASE_SERVICE_ACCOUNT_BASE64: 'eyJmYWtlIjoidmFsb3IifQ==',
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

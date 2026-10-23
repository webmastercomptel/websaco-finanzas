import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the wiring that no unit test of `script-env.ts` can see: the order of
 * imports and the first statement of `main` in every script that opens Mongo.
 * Text checks, because the thing being protected IS source order — an ES
 * import moved below `../app.module` type-checks, lints and silently loads the
 * wrong environment.
 *
 * "Opens Mongo" means booting the app context (`createApplicationContext`) OR
 * connecting with Mongoose directly (`mongoose.connect(`: the two scripts that
 * skip `AppModule` to avoid a Redis client). Missing the second kind would
 * leave a script that can write to any database with no environment guard.
 */
const APERTURAS = [
  'NestFactory.createApplicationContext(',
  'mongoose.connect(',
];

const scripts = readdirSync(__dirname)
  .filter((nombre) => nombre.endsWith('.ts') && !nombre.endsWith('.spec.ts'))
  .map((nombre) => ({
    nombre,
    codigo: readFileSync(join(__dirname, nombre), 'utf8'),
  }))
  .filter(({ codigo }) =>
    APERTURAS.some((apertura) => codigo.includes(apertura)),
  );

/** Position of the import of `modulo` (`from '<modulo>'` or `import '<modulo>'`). */
function posicionImport(codigo: string, modulo: string): number {
  const literal = modulo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patron = new RegExp(`^import\\b[^;]*?['"]${literal}['"];`, 'm');
  return codigo.search(patron);
}

/** Position of the first call that opens a connection. */
function posicionApertura(codigo: string): number {
  return Math.min(
    ...APERTURAS.map((apertura) => codigo.indexOf(apertura)).filter(
      (posicion) => posicion >= 0,
    ),
  );
}

describe('scripts de src/seed que abren Mongo', () => {
  it('se detectan los scripts (si esta lista queda vacía, el resto de la spec no prueba nada)', () => {
    expect(scripts.length).toBeGreaterThanOrEqual(7);
  });

  describe.each(scripts)('$nombre', ({ codigo }) => {
    it('importa dns-setup primero, luego load-script-env y, si arranca la app, recién después app.module', () => {
      const dns = posicionImport(codigo, '../common/dns-setup');
      const entorno = posicionImport(
        codigo,
        '../common/scripts/load-script-env',
      );
      const app = posicionImport(codigo, '../app.module');

      expect(dns).toBeGreaterThanOrEqual(0);
      expect(entorno).toBeGreaterThan(dns);
      if (codigo.includes('NestFactory.createApplicationContext(')) {
        expect(app).toBeGreaterThan(entorno);
      }
    });

    it('no lee el .env común por su cuenta (el único origen es .env.<ambiente>)', () => {
      expect(codigo).not.toMatch(/loadEnvFile\(\s*['"]\.env['"]/);
    });

    it('empieza su main con await confirmScriptEnv() antes de abrir la conexión', () => {
      // `main` is the last `async function` declared before the call that opens
      // the connection; a helper declared earlier in the file is not mistaken
      // for it.
      const apertura = posicionApertura(codigo);
      const candidatas = [
        ...codigo
          .slice(0, apertura)
          .matchAll(
            /async function \w+\s*\([^)]*\)[^{]*\{\s*(?<primera>[^;]+;)/g,
          ),
      ];

      expect(apertura).toBeGreaterThan(0);
      expect(candidatas.at(-1)?.groups?.primera.trim()).toBe(
        'await confirmScriptEnv();',
      );
    });
  });
});

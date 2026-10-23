// src/common/scripts/load-script-env.ts
//
// Side-effect module: selects the environment of a script from `--env=<name>`.
// Import it as the SECOND import of every script that opens Mongo — right after
// `common/dns-setup` and BEFORE `../app.module`.
//
// What it guarantees: `.env.<name>` is the ONLY source of the app's variables
// in that run. Its values replace the shell's, an app variable it omits is
// dropped even if the shell exported it, and the plain `.env` is not read (this
// module switches on script mode and `AppModule` then builds `ConfigModule`
// with `ignoreEnvFile`). Joi still fails loudly for a missing required
// variable. There is no fallback to `.env`.
//
// Order is the whole point. `app.module.ts` calls `ConfigModule.forRoot` while
// the module is being evaluated, and that call reads `process.env`, decides
// whether to read `.env` and runs the Joi validation synchronously. ES imports
// are hoisted and run in source order (ts-node compiles them to CommonJS
// `require`s in that same order), so this file's top-level code has finished
// loading `.env.<name>` and enabling script mode by the time `AppModule` is
// first required. Imported after it, the plain `.env` would already have been
// read and validated.
//
// Missing/invalid flag or missing file → message in Spanish and exit code 1
// BEFORE any Nest or Mongo code runs.
import { envValidationSchema } from '../../config/env.validation';
import {
  askFromConsole,
  confirmTarget,
  loadEnvFile,
  parseDatabaseOverride,
  parseEnvName,
  ScriptEnvError,
} from './script-env';
import { activateScriptEnvMode } from './script-mode';

/** Every variable the app reads: the keys of the Joi schema. */
const KNOWN_KEYS = Object.keys(
  (envValidationSchema.describe() as { keys?: Record<string, unknown> }).keys ??
    {},
);

/** Prints an operator error without a stack trace and stops the script. */
function exitWith(error: unknown): never {
  if (error instanceof ScriptEnvError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

let envName: string;
try {
  envName = parseEnvName(process.argv.slice(2));
  const loaded = loadEnvFile({
    name: envName,
    directory: process.cwd(),
    env: process.env,
    knownKeys: KNOWN_KEYS,
  });
  activateScriptEnvMode();
  console.log(
    `Ambiente "${loaded.name}": variables cargadas de ${loaded.path} (el .env común no se lee).`,
  );
  if (loaded.overridden.length > 0) {
    console.warn(
      `Aviso: el archivo reemplazó variables ya definidas en la terminal: ${loaded.overridden.join(', ')}`,
    );
  }
  if (loaded.discardedFromShell.length > 0) {
    console.warn(
      `Aviso: la terminal tenía estas variables y se descartaron porque el archivo no las define: ${loaded.discardedFromShell.join(', ')}`,
    );
  }
  if (loaded.omitted.length > 0) {
    console.warn(
      `Aviso: el archivo no define: ${loaded.omitted.join(', ')}. Si alguna es requerida la validación fallará; las opcionales quedan sin valor (p. ej. sin COMPTABLE_API_URL y COMPTABLE_HMAC_SECRET la integración con Comptable queda deshabilitada).`,
    );
  }
} catch (error) {
  exitWith(error);
}

/**
 * Shows the target database and, for any environment outside the
 * non-production allow-list, asks for its name (interactive terminal only).
 * Call it as the FIRST statement of the script's `main`, before `NestFactory`
 * opens the connection: nothing connects at import time, so the operator can
 * still back out here.
 *
 * The scripts that connect with their own `--db=<name>` flag (they bypass
 * `AppModule`) get that name reported and asked for, since it overrides the
 * database of the URI.
 */
export async function confirmScriptEnv(): Promise<void> {
  try {
    await confirmTarget({
      envName,
      env: process.env,
      ask: askFromConsole,
      print: (line) => console.log(line),
      isInteractive: Boolean(process.stdin.isTTY),
      databaseOverride: parseDatabaseOverride(process.argv.slice(2)),
    });
  } catch (error) {
    exitWith(error);
  }
}

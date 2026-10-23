// src/common/scripts/script-env.ts
//
// Pure(ish) building blocks of the `--env=<name>` selector shared by every
// script that opens Mongo (`src/seed/*.ts`). Kept free of side effects so each
// rule is unit-testable; `load-script-env.ts` is the thin entrypoint that wires
// them to `process`.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';

/**
 * Environment names a script may target WITHOUT typing a confirmation. An
 * explicit allow-list of the non-production names, not a block-list of
 * "production"/"prod": a block-list passes `produccion`, `prd`, `staging` or
 * any typo straight through to a real database, while an allow-list fails safe
 * — a name nobody thought about asks for confirmation. Adding a name here is a
 * decision to stop protecting it, so it belongs in a reviewed diff.
 *
 * The guard trusts the NAME: a `.env.dev` that points at the production
 * database is not detected. The target is printed every time to make that
 * mistake visible.
 */
export const NON_PRODUCTION_ENVS: readonly string[] = [
  'local',
  'dev',
  'development',
  'test',
];

/**
 * Lowercase letters, digits and hyphens only. The name becomes part of a file
 * path (`.env.<name>`), so anything with a separator or a dot (`../x`,
 * `a/b`, `prod.bak`) must never get that far.
 */
const ENV_NAME_PATTERN = /^[a-z0-9-]+$/;
const ENV_FLAG = '--env';

/**
 * A problem the operator can fix (bad flag, missing file, wrong confirmation).
 * Distinct from a programming error so the entrypoint can print the message
 * and exit without a stack trace.
 */
export class ScriptEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptEnvError';
  }
}

const USAGE = [
  'Falta indicar el ambiente. Uso:',
  '  npm run <script> -- --env=<ambiente>',
  'El "--" antes de --env es obligatorio: sin él npm descarta la bandera.',
  'Ejemplo: npm run seed:admin -- --env=local',
  'Se lee el archivo .env.<ambiente> de la raíz del backend.',
].join('\n');

/**
 * Extracts the environment name from the script's arguments. There is no
 * default on purpose (repo rule: no silent fallbacks): a script that quietly
 * used the plain `.env` when the flag was forgotten would write to whichever
 * database that file happens to hold.
 */
export function parseEnvName(argv: readonly string[]): string {
  const flags = argv.filter(
    (arg) => arg === ENV_FLAG || arg.startsWith(`${ENV_FLAG}=`),
  );
  if (flags.length === 0) throw new ScriptEnvError(USAGE);
  if (flags.length > 1) {
    throw new ScriptEnvError(
      'Indicaste --env más de una vez: deja uno solo.\n' + USAGE,
    );
  }
  if (flags[0] === ENV_FLAG) {
    throw new ScriptEnvError(
      'Escribe --env=<ambiente> (con "=", sin espacios).\n' + USAGE,
    );
  }
  const name = flags[0].slice(ENV_FLAG.length + 1);
  if (!ENV_NAME_PATTERN.test(name)) {
    throw new ScriptEnvError(
      `Nombre de ambiente inválido "${name}": solo minúsculas, números y guiones.`,
    );
  }
  return name;
}

/**
 * Value of the script's own `--db=<name>` flag, if it passed one. Only the
 * scripts that connect with `mongoose.connect(uri, { dbName })` define it
 * (`sembrar:consecutivos`, `limpiar:indices-ingles`); for the rest it is absent
 * and the URI's database stands. Never throws: the script itself validates
 * what it needs from the flag.
 */
export function parseDatabaseOverride(
  argv: readonly string[],
): string | undefined {
  const flag = argv.find((arg) => arg.startsWith('--db='));
  return flag ? flag.slice('--db='.length) || undefined : undefined;
}

/** Whether targeting this environment requires typing the database name. */
export function needsConfirmation(envName: string): boolean {
  return !NON_PRODUCTION_ENVS.includes(envName);
}

/** What a MongoDB connection string points at — never its credentials. */
export interface MongoTarget {
  /** Host list as written (may be several, comma-separated). */
  host: string;
  /** Database name; `test` when the URI names none (the driver's default). */
  database: string;
  /** The URI with user and password replaced by `***`, query string dropped. */
  masked: string;
}

/**
 * One entry of the host list: a DNS name or bracketed IPv6, with an optional
 * numeric port. Strict on purpose — `user:pass` does NOT match (the "port" is
 * not digits), which is what makes a password with an unencoded delimiter fail
 * closed instead of being printed as if it were a host.
 */
const HOST_ENTRY =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

const UNEXPECTED_URI_FORMAT =
  'No se pudo interpretar MONGODB_URI (formato inesperado). Si el usuario o la contraseña tienen caracteres especiales (@ / ? : %), deben ir codificados (%40, %2F, %3F, %3A, %25).';

/**
 * Describes where a `MONGODB_URI` points, safely.
 *
 * `databaseOverride` is for the scripts that connect with an explicit
 * `--db=<name>` (`dbName` option of `mongoose.connect`): that name wins over
 * whatever the URI says, so it is the database the script will really touch and
 * the one the operator must see and type. Empty or absent = the URI's own.
 *
 * Hand-parsed because `new URL()` rejects the multi-host form Atlas' legacy
 * string uses (see the note in `env.validation.ts`). Credentials are split from
 * the host ONLY inside the authority — the text between `://` and the first
 * `/` or `?` — at its last `@`. An `@` later on (`?appName=ops@laptop`, a path)
 * belongs to the path or query and must never be taken for the credentials
 * separator, or the wrong host would be reported.
 *
 * It fails closed rather than guessing: every host entry must look like a host,
 * and a URI with no userinfo whose path holds an `@` (the signature of a
 * password with an unencoded `/`) is rejected. The error never echoes the
 * input, so a rejected URI cannot leak its password either.
 */
export function describeMongoTarget(
  uri: string | undefined,
  databaseOverride?: string,
): MongoTarget {
  if (!uri) {
    throw new ScriptEnvError('MONGODB_URI no está definida en el ambiente.');
  }
  const scheme = /^(mongodb(?:\+srv)?):\/\//.exec(uri);
  if (!scheme) {
    throw new ScriptEnvError(
      'MONGODB_URI debe empezar con mongodb:// o mongodb+srv://',
    );
  }
  const rest = uri.slice(scheme[0].length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);

  const at = authority.lastIndexOf('@');
  const hasCredentials = at !== -1;
  const host = authority.slice(at + 1);
  if (!host.split(',').every((entry) => HOST_ENTRY.test(entry))) {
    throw new ScriptEnvError(UNEXPECTED_URI_FORMAT);
  }

  const rawDatabase = tail.startsWith('/') ? tail.slice(1).split('?')[0] : '';
  if (!hasCredentials && rawDatabase.includes('@')) {
    throw new ScriptEnvError(UNEXPECTED_URI_FORMAT);
  }
  let database = rawDatabase;
  try {
    database = decodeURIComponent(rawDatabase);
  } catch {
    // Keep the raw text: it is only displayed.
  }
  if (databaseOverride) database = databaseOverride;
  if (!database) database = 'test';

  return {
    host,
    database,
    masked: `${scheme[1]}://${hasCredentials ? '***@' : ''}${host}/${database}`,
  };
}

/** What `loadEnvFile` did, so the entrypoint can report it (names only). */
export interface LoadedEnv {
  name: string;
  /** Absolute path of the file that was read. */
  path: string;
  /** Variables the file defines. */
  keys: string[];
  /** Variables that already had a DIFFERENT value in the shell and were replaced. */
  overridden: string[];
  /**
   * App variables (`knownKeys`) the file does not define. A required one will
   * fail Joi's validation loudly; an optional one stays unset, which can
   * switch a feature off (e.g. no `COMPTABLE_HMAC_SECRET` = integration off).
   */
  omitted: string[];
  /**
   * The subset of `omitted` that the shell had exported and `loadEnvFile`
   * removed, so a stale export cannot leak into the run.
   */
  discardedFromShell: string[];
}

export interface LoadEnvOptions {
  name: string;
  /** Directory holding the env files — the backend root (`process.cwd()`). */
  directory: string;
  /** Object to load into; `process.env` in production, a plain object in tests. */
  env: NodeJS.ProcessEnv;
  /**
   * Every variable the app reads (the keys of the Joi schema). Needed to make
   * the file authoritative without wiping unrelated shell variables such as
   * `PATH`: only these are removed when the file omits them.
   */
  knownKeys?: readonly string[];
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
}

/**
 * Loads `.env.<name>` into `env` as the SINGLE source of the app's variables.
 *
 * Authority, decided on purpose (owner-approved review): the file is the only
 * source. (1) Its values replace whatever the shell exported — a stale
 * `MONGODB_URI` must not redirect the run. (2) An app variable the file omits is
 * REMOVED from `env` if the shell had it — otherwise the same stale export would
 * leak in by the back door. (3) The plain `.env` is not read at all: the entry
 * point turns on script mode (`script-mode.ts`) and `AppModule` then builds its
 * `ConfigModule` with `ignoreEnvFile`. Joi still fails loudly for a missing
 * required variable. Consequence: `ROOT_ADMIN_EMAIL` for `seed:admin` must be in
 * the file; exporting it in the shell is discarded (and reported).
 *
 * Must run before `AppModule` is evaluated: `ConfigModule.forRoot` reads and
 * validates `process.env` at that moment.
 *
 * The file must define `MONGODB_URI`: it is the one value the confirmation
 * guard reports, and the guard must describe the database the file chose.
 *
 * Uses Node's `util.parseEnv` (Node >= 20.12; the engine is 22), not `dotenv`:
 * `dotenv` is only a transitive dependency of `@nestjs/config`, and importing
 * it directly would depend on a package nobody declared.
 */
export function loadEnvFile(options: LoadEnvOptions): LoadedEnv {
  const exists = options.exists ?? existsSync;
  const read = options.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const path = resolve(options.directory, `.env.${options.name}`);

  if (!exists(path)) {
    throw new ScriptEnvError(
      `No existe el archivo del ambiente "${options.name}". Se esperaba: ${path}`,
    );
  }
  const values = parseEnv(read(path));
  if (!values.MONGODB_URI) {
    throw new ScriptEnvError(
      `${path} no define MONGODB_URI: cada archivo de ambiente debe traer su propia conexión.`,
    );
  }

  const overridden = Object.keys(values).filter(
    (key) => options.env[key] !== undefined && options.env[key] !== values[key],
  );
  const omitted = (options.knownKeys ?? []).filter((key) => !(key in values));
  const discardedFromShell = omitted.filter(
    (key) => options.env[key] !== undefined,
  );

  for (const key of discardedFromShell) delete options.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) options.env[key] = value;
  }

  return {
    name: options.name,
    path,
    keys: Object.keys(values),
    overridden,
    omitted,
    discardedFromShell,
  };
}

export interface ConfirmTargetOptions {
  envName: string;
  /** Environment after `loadEnvFile`; its `MONGODB_URI` is the target. */
  env: NodeJS.ProcessEnv;
  /** Prompts and returns the typed answer. Injected so tests need no terminal. */
  ask: (question: string) => Promise<string>;
  print: (line: string) => void;
  /**
   * Whether a person is at the keyboard (`process.stdin.isTTY`). Injected for
   * tests; the entrypoint passes the real value.
   */
  isInteractive: boolean;
  /**
   * Database named by the script's own `--db=<name>` flag, when it has one;
   * see `describeMongoTarget`.
   */
  databaseOverride?: string;
}

/**
 * Prints where the script is about to write and, unless the environment is on
 * the non-production allow-list, makes the operator type the database name.
 * Typing it (rather than answering y/n) forces a look at WHICH database it is:
 * `y` is muscle memory, a database name is not.
 *
 * It also requires an interactive terminal: with piped input
 * (`echo nombre-de-la-base | npm run ...`) the "confirmation" would be a script
 * answering itself, which defeats the point of making a human type it.
 */
export async function confirmTarget(
  options: ConfirmTargetOptions,
): Promise<void> {
  const target = describeMongoTarget(
    options.env.MONGODB_URI,
    options.databaseOverride,
  );
  options.print(`Ambiente: ${options.envName}`);
  options.print(`Destino: ${target.masked}`);

  if (!needsConfirmation(options.envName)) return;

  if (!options.isInteractive) {
    throw new ScriptEnvError(
      `El ambiente "${options.envName}" exige confirmación escrita y esta ejecución no es interactiva (la entrada no es una terminal): no se acepta una respuesta por pipe ni redirección. Corre el script directamente en una terminal.`,
    );
  }

  const answer = await options.ask(
    `"${options.envName}" no está entre los ambientes no productivos (${NON_PRODUCTION_ENVS.join(', ')}).\n` +
      `Para continuar escribe el nombre de la base de datos (${target.database}): `,
  );
  if (answer.trim() !== target.database) {
    throw new ScriptEnvError(
      'La confirmación no coincide con la base de datos. No se hizo ningún cambio.',
    );
  }
}

/**
 * The terminal side of `confirmTarget`. An input that closes with no answer
 * (CI, `< /dev/null`) resolves as an empty answer, which fails the check —
 * without the `close` listener the promise would never settle and the process
 * would exit silently with code 0, which reads as success.
 */
export function askFromConsole(question: string): Promise<string> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.once('close', () => resolveAnswer(''));
    rl.question(question, (answer) => {
      resolveAnswer(answer);
      rl.close();
    });
  });
}

import type { ConfigModuleOptions } from '@nestjs/config';
import { isScriptEnvMode } from '../common/scripts/script-mode';
import appConfig from './app.config';
import { envValidationSchema } from './env.validation';

/**
 * Options of `ConfigModule.forRoot` in `AppModule`, extracted so the one
 * conditional in them has a spec.
 *
 * `ignoreEnvFile` is `true` ONLY in a script that chose its environment with
 * `--env=<name>` (see `common/scripts/load-script-env.ts`): that script has
 * already put `.env.<name>` into `process.env`, and letting `ConfigModule` also
 * read the plain `.env` would fill every variable the chosen file omits with
 * values from another environment. In a normal server boot it is `false`,
 * Nest's default, so boot behaves exactly as before.
 */
export function buildConfigModuleOptions(
  ignoreEnvFile: boolean = isScriptEnvMode(),
): ConfigModuleOptions {
  return {
    isGlobal: true,
    load: [appConfig],
    validationSchema: envValidationSchema,
    ignoreEnvFile,
  };
}

// src/common/scripts/script-mode.ts
//
// One boolean shared between `load-script-env.ts` (writer) and `app.module.ts`
// (reader, through `config/config-module-options.ts`). Module state instead of
// an environment-variable marker: a marker in `process.env` could be set by
// accident on a server, and it would also be inherited by child processes.
// Node's module cache guarantees both sides see the same instance inside one
// process; a server boot never imports the writer, so it always reads `false`.
let scriptEnvMode = false;

/**
 * Called by `load-script-env.ts` once `.env.<name>` is loaded: from now on the
 * plain `.env` must not be read, or any variable the chosen file omits would
 * silently come from another environment's file.
 */
export function activateScriptEnvMode(): void {
  scriptEnvMode = true;
}

/** Whether this process is a script that selected its environment with `--env`. */
export function isScriptEnvMode(): boolean {
  return scriptEnvMode;
}

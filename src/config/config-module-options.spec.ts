import { activateScriptEnvMode } from '../common/scripts/script-mode';
import appConfig from './app.config';
import { buildConfigModuleOptions } from './config-module-options';
import { envValidationSchema } from './env.validation';

describe('buildConfigModuleOptions', () => {
  it('en el arranque normal del servidor sigue leyendo el .env (ignoreEnvFile en false)', () => {
    // First test of the file: nothing has activated the script mode yet, which
    // is exactly the state of a server boot (it never imports the writer).
    expect(buildConfigModuleOptions().ignoreEnvFile).toBe(false);
  });

  it('conserva la configuración global, la carga de app y la validación Joi', () => {
    const opciones = buildConfigModuleOptions(false);

    expect(opciones.isGlobal).toBe(true);
    expect(opciones.load).toEqual([appConfig]);
    expect(opciones.validationSchema).toBe(envValidationSchema);
  });

  it('un script con --env ignora el .env común para que no se filtren variables de otro ambiente', () => {
    expect(buildConfigModuleOptions(true).ignoreEnvFile).toBe(true);
  });

  it('toma el modo del script activado por load-script-env cuando no se pasa el valor', () => {
    activateScriptEnvMode();

    expect(buildConfigModuleOptions().ignoreEnvFile).toBe(true);
  });
});

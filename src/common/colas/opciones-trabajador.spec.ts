import { ConsolidacionProcessor } from '../../modules/facturacion/colas/consolidacion.processor';
import { AplicacionLoteRecibosProcessor } from '../../modules/recibos/colas/aplicacion-lote-recibos.processor';
import { LOCK_DURATION_TRABAJADOR_MS } from './opciones-trabajador';

/** Same key @nestjs/bullmq reads the worker options from (bull.constants). */
const WORKER_METADATA = 'bullmq:worker_metadata';

const opcionesDe = (clase: object): unknown =>
  Reflect.getMetadata(WORKER_METADATA, clase);

describe('vigencia del candado de los trabajadores de lote', () => {
  it('es de 5 minutos: lo que tarda la solicitud más larga de Cloud Run', () => {
    // Menos que eso y un paso síncrono largo (el ciclo de eventos sin renovar el
    // candado) marcaría el job como detenido y lo repetiría en paralelo; más no
    // sirve: pasado el plazo de la solicitud nadie espera ya el resultado.
    expect(LOCK_DURATION_TRABAJADOR_MS).toBe(300_000);
  });

  it.each([
    ['consolidación de lotes', ConsolidacionProcessor],
    ['aplicación de lotes de recibos', AplicacionLoteRecibosProcessor],
  ])('el trabajador de %s declara lockDuration explícito', (_nombre, clase) => {
    expect(opcionesDe(clase)).toMatchObject({
      lockDuration: LOCK_DURATION_TRABAJADOR_MS,
    });
  });
});

import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { NestFactory } from '@nestjs/core';
import { ProcesoModule } from './proceso.module';
import { establecerRolProceso, rolProcesoActual } from './rol-proceso';

/** Every Worker the explorer would open against Redis, replaced by a counter. */
const creados: string[] = [];
class TrabajadorFalso {
  constructor(nombre: string) {
    creados.push(nombre);
  }
  on() {
    return this;
  }
  close() {
    return Promise.resolve();
  }
}

@Processor('cola-de-prueba')
@Injectable()
class ProcesadorDePrueba extends WorkerHost {
  process(): Promise<void> {
    return Promise.resolve();
  }
}

// Registering a queue is what makes BullRegistrar available, as in the real app.
@Module({
  imports: [BullModule.registerQueue({ name: 'cola-de-prueba' })],
  providers: [ProcesadorDePrueba],
})
class ModuloConProcesador {}

async function arrancar(rol: string | undefined) {
  @Module({
    imports: [
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        isGlobal: true,
        load: [() => ({ app: { appRole: rol } })],
      }),
      // Same switch AppModule uses: nothing registers on its own.
      BullModule.forRootAsync({
        useFactory: () => ({ connection: { url: 'redis://127.0.0.1:1' } }),
        extraOptions: { manualRegistration: true },
      }),
      ModuloConProcesador,
      ProcesoModule,
    ],
  })
  class Raiz {}
  return NestFactory.createApplicationContext(Raiz, {
    logger: false,
    abortOnError: false,
  });
}

describe('ProcesoModule', () => {
  beforeAll(() => {
    BullModule.workerClass = TrabajadorFalso as never;
  });

  beforeEach(() => {
    creados.length = 0;
    establecerRolProceso('all');
  });

  it.each(['all', 'worker'])(
    'con APP_ROLE=%s abre los trabajadores de cola',
    async (rol) => {
      const app = await arrancar(rol);
      expect(creados).toEqual(['cola-de-prueba']);
      expect(rolProcesoActual()).toBe(rol);
      await app.close();
    },
  );

  it('con APP_ROLE=api no abre ningún trabajador y lo deja anotado para los crons', async () => {
    const app = await arrancar('api');
    expect(creados).toEqual([]);
    expect(rolProcesoActual()).toBe('api');
    await app.close();
  });

  it('sin APP_ROLE configurado se comporta como all', async () => {
    const app = await arrancar(undefined);
    expect(creados).toEqual(['cola-de-prueba']);
    expect(rolProcesoActual()).toBe('all');
    await app.close();
  });
});

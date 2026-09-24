import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  PublicacionFacturasService,
  type Desenlace,
  type FilaReclamada,
} from './publicacion-facturas.service';
import {
  CLAIM_TTL_MS,
  LOTE_MAXIMO_POR_CICLO,
  URL_LECTURA_TTL_MS,
} from './publicacion-facturas.politica';
import type { LoteFacturasPdfConfirmadoEvent } from '../../common/eventos/lote-facturas-pdf-confirmado.event';

// `procesar` is intentionally private on the service — accessed here via a
// standalone (non-intersected) shape cast through `unknown`, the only way
// to reach it without TypeScript collapsing an intersection with a private
// member into `never`.
interface ServicioConPrivados {
  procesar: (fila: FilaReclamada, max: number) => Promise<Desenlace>;
}

const CONFIG_COMPLETA: Record<string, unknown> = {
  'app.websaco3FacturasEndpointUrl': 'https://websaco3.example.com/recepcion',
  'app.websaco3HmacSecret': 'un-secreto-compartido-de-al-menos-32-caracteres',
  'app.websaco3PublicacionMaxIntentos': 6,
};

const mockConfig = (valores: Record<string, unknown> = CONFIG_COMPLETA) => ({
  get: jest.fn((clave: string) => valores[clave]),
});

const mockCopropiedades = (documento: Record<string, unknown> | null) => ({
  findById: jest.fn(() => ({
    select: () => ({
      lean: () => ({ exec: () => Promise.resolve(documento) }),
    }),
  })),
});

const mockFilas = (over: Partial<Record<string, jest.Mock>> = {}) => ({
  updateOne: jest.fn(() => ({
    exec: () => Promise.resolve({ modifiedCount: 1 }),
  })),
  updateMany: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  findOneAndUpdate: jest.fn(() => ({
    lean: () => ({ exec: () => Promise.resolve(null) }),
  })),
  ...over,
});

const mockStorage = (
  resultado: { url: string; expiresAt: Date } = {
    url: 'https://storage.googleapis.com/bucket/lote-1.pdf?signed=1',
    expiresAt: new Date('2026-01-01T01:00:00.000Z'),
  },
) => ({
  generarUrlLectura: jest.fn(() => Promise.resolve(resultado)),
});

const FILA_BASE: FilaReclamada = {
  _id: new Types.ObjectId('507f1f77bcf86cd799439013'),
  coPropertyId: new Types.ObjectId('507f1f77bcf86cd799439011'),
  loteId: new Types.ObjectId('507f1f77bcf86cd799439012'),
  taxId: '900123456',
  invoiceNumbers: ['FV-1', 'FV-2'],
  objectPath: 'coproprietats/cop-1/lotes/lote-1.pdf',
  status: 'enviando',
  retryable: true,
  attempts: 1,
  nextAttemptAt: null,
  claimedAt: new Date(),
  claimToken: 'token-1',
  lastStatusCode: null,
  lastError: null,
  sentAt: null,
};

const COPROPERTY_ID = '507f1f77bcf86cd799439011';
const LOTE_ID = '507f1f77bcf86cd799439012';

const EVENTO: LoteFacturasPdfConfirmadoEvent = {
  coPropertyId: COPROPERTY_ID,
  loteId: LOTE_ID,
  objectPath: 'coproprietats/cop-1/lotes/lote-1.pdf',
  numerosFactura: ['FV-1', 'FV-2'],
};

describe('PublicacionFacturasService.encolar', () => {
  it('la copropiedad con el flag apagado no escribe ninguna fila', async () => {
    const copropiedades = mockCopropiedades({
      usesBuildingManagement: false,
      taxId: null,
    });
    const filas = mockFilas();
    const service = new PublicacionFacturasService(
      filas as never,
      copropiedades as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await service.encolar(EVENTO);

    expect(filas.updateOne).not.toHaveBeenCalled();
  });

  it('el flag activo sin NIT tampoco escribe (fila legacy, se omite con warning)', async () => {
    const copropiedades = mockCopropiedades({
      usesBuildingManagement: true,
      taxId: null,
    });
    const filas = mockFilas();
    const service = new PublicacionFacturasService(
      filas as never,
      copropiedades as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await service.encolar(EVENTO);

    expect(filas.updateOne).not.toHaveBeenCalled();
  });

  it('hace upsert con $setOnInsert cuando el flag y el NIT están completos', async () => {
    const copropiedades = mockCopropiedades({
      usesBuildingManagement: true,
      taxId: '900123456',
    });
    const filas = mockFilas();
    const service = new PublicacionFacturasService(
      filas as never,
      copropiedades as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await service.encolar(EVENTO);

    expect(filas.updateOne).toHaveBeenCalledTimes(1);
    const [filtro, update, opciones] = filas.updateOne.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opciones).toEqual({ upsert: true });
    expect(update.$setOnInsert).toMatchObject({
      taxId: '900123456',
      invoiceNumbers: ['FV-1', 'FV-2'],
      objectPath: EVENTO.objectPath,
      status: 'pendiente',
      retryable: true,
      attempts: 0,
    });
    expect(filtro).toHaveProperty('loteId');
  });

  it('un E11000 (carrera de upserts concurrentes) se traga como no-op', async () => {
    const copropiedades = mockCopropiedades({
      usesBuildingManagement: true,
      taxId: '900123456',
    });
    const error = Object.assign(new Error('duplicate key'), { code: 11000 });
    const filas = mockFilas({
      updateOne: jest.fn(() => ({ exec: () => Promise.reject(error) })),
    });
    const service = new PublicacionFacturasService(
      filas as never,
      copropiedades as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await expect(service.encolar(EVENTO)).resolves.toBeUndefined();
  });

  it('un error que NO es E11000 se propaga', async () => {
    const copropiedades = mockCopropiedades({
      usesBuildingManagement: true,
      taxId: '900123456',
    });
    const filas = mockFilas({
      updateOne: jest.fn(() => ({
        exec: () => Promise.reject(new Error('mongo down')),
      })),
    });
    const service = new PublicacionFacturasService(
      filas as never,
      copropiedades as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await expect(service.encolar(EVENTO)).rejects.toThrow('mongo down');
  });
});

describe('PublicacionFacturasService.reclamar', () => {
  it('arma el filtro/update atómico exacto, incluyendo la rama de enviando vencido y el guard attempts<max', async () => {
    const filas = mockFilas();
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await service.reclamar(6);

    expect(filas.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro, update, opciones] = filas.findOneAndUpdate.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect(filtro.attempts).toEqual({ $lt: 6 });
    const or = filtro.$or as Record<string, unknown>[];
    expect(or).toHaveLength(2);
    expect(or[0]).toMatchObject({
      status: { $in: ['pendiente', 'fallido'] },
      retryable: true,
    });
    expect(or[0]).toHaveProperty('nextAttemptAt');
    expect(or[1]).toMatchObject({ status: 'enviando' });
    expect(or[1]).toHaveProperty('claimedAt');

    expect((update.$set as Record<string, unknown>).status).toBe('enviando');
    expect(update.$inc).toEqual({ attempts: 1 });
    expect(opciones).toMatchObject({
      sort: { nextAttemptAt: 1 },
      returnDocument: 'after',
    });
  });
});

// W4.1 / W4.2: `reclamar` es un único `findOneAndUpdate` atómico, así que la
// exclusividad real (una segunda llamada sobre la misma fila ya reclamada no
// la vuelve a tomar) y el límite exacto de la ventana de reclamo vencido no
// se pueden probar sólo espiando el filtro/update pasado al mock, como hace
// el describe anterior — hay que simular, sobre un documento en memoria, el
// MISMO predicado que ese filtro le pide a MongoDB, y verificar que el
// resultado cambia según el estado. Sigue la convención de mocks a mano de
// `backend/CLAUDE.md`; no se levanta un MongoDB real para esto.
describe('PublicacionFacturasService.reclamar — exclusividad y ventana de reclamo vencido', () => {
  /** Replica el predicado exacto de `reclamar` (service.ts) contra UNA fila
   *  en memoria: `attempts < max` Y (pendiente/fallido retryable due, O
   *  enviando con claimedAt <= vencido). */
  function coincideFiltroDeReclamo(
    fila: FilaReclamada,
    max: number,
    ahora: Date,
    vencido: Date,
  ): boolean {
    if (!(fila.attempts < max)) return false;
    const ramaDisponible =
      (fila.status === 'pendiente' || fila.status === 'fallido') &&
      fila.retryable === true &&
      fila.nextAttemptAt !== null &&
      fila.nextAttemptAt.getTime() <= ahora.getTime();
    const ramaEnviandoVencido =
      fila.status === 'enviando' &&
      fila.claimedAt !== null &&
      fila.claimedAt.getTime() <= vencido.getTime();
    return ramaDisponible || ramaEnviandoVencido;
  }

  /** Un `filas` falso cuyo `findOneAndUpdate` aplica ese mismo predicado
   *  sobre un único documento mutable — cada llamada ve el estado que dejó
   *  la anterior, igual que un `findOneAndUpdate` real sobre la misma fila. */
  function mockFilasSimuladas(inicial: FilaReclamada) {
    let estado: FilaReclamada = { ...inicial };
    let intentoToken = 0;
    return {
      estadoActual: () => estado,
      findOneAndUpdate: jest.fn((filtro: { attempts: { $lt: number } }) => ({
        lean: () => ({
          exec: () => {
            const ahora = new Date();
            const vencido = new Date(ahora.getTime() - CLAIM_TTL_MS);
            const max = filtro.attempts.$lt;
            if (!coincideFiltroDeReclamo(estado, max, ahora, vencido)) {
              return Promise.resolve(null);
            }
            intentoToken += 1;
            estado = {
              ...estado,
              status: 'enviando',
              claimedAt: ahora,
              claimToken: `token-${intentoToken}`,
              attempts: estado.attempts + 1,
            };
            return Promise.resolve({ ...estado });
          },
        }),
      })),
    };
  }

  it('una segunda llamada sobre la misma fila ya reclamada (enviando, no vencida) devuelve null', async () => {
    const filaDisponible: FilaReclamada = {
      ...FILA_BASE,
      status: 'pendiente',
      retryable: true,
      attempts: 0,
      nextAttemptAt: new Date(Date.now() - 1_000),
      claimedAt: null,
      claimToken: null,
    };
    const filas = mockFilasSimuladas(filaDisponible);
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    const primeraReclamada = await service.reclamar(6);
    const segundaReclamada = await service.reclamar(6);

    expect(primeraReclamada).not.toBeNull();
    expect(primeraReclamada?.status).toBe('enviando');
    expect(segundaReclamada).toBeNull();
  });

  it('una fila reclamada hace más tiempo que CLAIM_TTL_MS es reclamable de nuevo', async () => {
    jest.useFakeTimers();
    const ahoraFija = new Date('2026-01-01T00:10:00.000Z');
    jest.setSystemTime(ahoraFija);
    const vencidoLimite = new Date(ahoraFija.getTime() - CLAIM_TTL_MS);

    const filaVieja: FilaReclamada = {
      ...FILA_BASE,
      status: 'enviando',
      claimedAt: new Date(vencidoLimite.getTime() - 1), // 1ms más viejo: vencido
      claimToken: 'reclamo-viejo',
      attempts: 1,
    };
    const filas = mockFilasSimuladas(filaVieja);
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    const reclamada = await service.reclamar(6);

    expect(reclamada).not.toBeNull();
    expect(reclamada?.status).toBe('enviando');

    jest.useRealTimers();
  });

  it('el borde exacto del TTL (claimedAt == vencido) es reclamable; 1ms más nuevo no lo es', async () => {
    jest.useFakeTimers();
    const ahoraFija = new Date('2026-01-01T00:10:00.000Z');
    jest.setSystemTime(ahoraFija);
    const vencidoLimite = new Date(ahoraFija.getTime() - CLAIM_TTL_MS);

    const filaJustoEnElLimite: FilaReclamada = {
      ...FILA_BASE,
      status: 'enviando',
      claimedAt: vencidoLimite, // == vencido → $lte lo incluye
      claimToken: 'limite-exacto',
      attempts: 1,
    };
    const filasEnLimite = mockFilasSimuladas(filaJustoEnElLimite);
    const serviceEnLimite = new PublicacionFacturasService(
      filasEnLimite as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );
    await expect(serviceEnLimite.reclamar(6)).resolves.not.toBeNull();

    const filaMasReciente: FilaReclamada = {
      ...FILA_BASE,
      status: 'enviando',
      claimedAt: new Date(vencidoLimite.getTime() + 1), // 1ms más nuevo: no vencido
      claimToken: 'mas-reciente',
      attempts: 1,
    };
    const filasReciente = mockFilasSimuladas(filaMasReciente);
    const serviceReciente = new PublicacionFacturasService(
      filasReciente as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );
    await expect(serviceReciente.reclamar(6)).resolves.toBeNull();

    jest.useRealTimers();
  });
});

describe('PublicacionFacturasService.procesar', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it.each([201, 202, 409])(
    'HTTP %i clasifica como enviado, terminal, sin reintento',
    async (status) => {
      global.fetch = jest.fn().mockResolvedValue({ status });
      const service = new PublicacionFacturasService(
        mockFilas() as never,
        mockCopropiedades(null) as never,
        mockStorage() as never,
        mockConfig() as never,
      );

      const desenlace = await (
        service as unknown as ServicioConPrivados
      ).procesar(FILA_BASE, 6);

      expect(desenlace.status).toBe('enviado');
      expect(desenlace.retryable).toBe(false);
      expect(desenlace.lastStatusCode).toBe(status);
      expect(desenlace.sentAt).toBeInstanceOf(Date);
    },
  );

  it.each([422, 502])(
    'HTTP %i clasifica como fallido reintentable (attempts < max)',
    async (status) => {
      global.fetch = jest.fn().mockResolvedValue({ status });
      const service = new PublicacionFacturasService(
        mockFilas() as never,
        mockCopropiedades(null) as never,
        mockStorage() as never,
        mockConfig() as never,
      );

      const desenlace = await (
        service as unknown as ServicioConPrivados
      ).procesar({ ...FILA_BASE, attempts: 1 }, 6);

      expect(desenlace.status).toBe('fallido');
      expect(desenlace.retryable).toBe(true);
      expect(desenlace.nextAttemptAt).toBeInstanceOf(Date);
      expect(desenlace.lastError).toBe(`HTTP ${status}`);
    },
  );

  it('un fallido reintentable que ya agotó max queda terminal', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 502 });
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, attempts: 6 }, 6);

    expect(desenlace.status).toBe('fallido');
    expect(desenlace.retryable).toBe(false);
    expect(desenlace.nextAttemptAt).toBeNull();
  });

  it.each([401, 403])(
    'HTTP %i clasifica como fallido terminal',
    async (status) => {
      global.fetch = jest.fn().mockResolvedValue({ status });
      const service = new PublicacionFacturasService(
        mockFilas() as never,
        mockCopropiedades(null) as never,
        mockStorage() as never,
        mockConfig() as never,
      );

      const desenlace = await (
        service as unknown as ServicioConPrivados
      ).procesar(FILA_BASE, 6);

      expect(desenlace.status).toBe('fallido');
      expect(desenlace.retryable).toBe(false);
      expect(desenlace.lastError).toBe(`HTTP ${status}`);
    },
  );

  it('un timeout de fetch clasifica como fallido reintentable', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    global.fetch = jest.fn().mockRejectedValue(abortError);
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, attempts: 1 }, 6);

    expect(desenlace.status).toBe('fallido');
    expect(desenlace.retryable).toBe(true);
    expect(desenlace.lastError).toBe('timeout');
  });

  it('un error de red clasifica como fallido reintentable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, attempts: 1 }, 6);

    expect(desenlace.status).toBe('fallido');
    expect(desenlace.retryable).toBe(true);
    expect(desenlace.lastError).toBe('red');
  });

  it('un fallo generando la URL firmada clasifica como fallido reintentable sin llamar a fetch', async () => {
    global.fetch = jest.fn();
    const storageQueRompe = {
      generarUrlLectura: jest.fn(() =>
        Promise.reject(new Error('bucket down')),
      ),
    };
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      storageQueRompe as never,
      mockConfig() as never,
    );

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, attempts: 1 }, 6);

    expect(desenlace.status).toBe('fallido');
    expect(desenlace.retryable).toBe(true);
    expect(desenlace.lastError).toBe('url-firmada');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('urlSigned nunca llega al logger en el camino de fallo reintentable (HTTP 422)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    global.fetch = jest.fn().mockResolvedValue({ status: 422 });
    const url = 'https://storage.googleapis.com/bucket/secreto-no-loguear.pdf';
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage({ url, expiresAt: new Date() }) as never,
      mockConfig() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(
      { ...FILA_BASE, attempts: 1 },
      6,
    );

    const todasLasLlamadas = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
    ].flat();
    for (const llamada of todasLasLlamadas) {
      expect(String(llamada)).not.toContain(url);
    }
  });

  // W4.5: el test de arriba sólo ejercitaba el camino 422, a pesar de que su
  // título original prometía cubrir "éxito y fallo". Estos tres casos
  // hermanos cubren, por separado, el camino de éxito y los dos caminos que
  // fallan ANTES de tener un status HTTP (timeout y error de red) — la
  // matriz completa de puntos donde `procesar` loguea algo.
  it('urlSigned nunca llega al logger en el camino de éxito (HTTP 201)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const url =
      'https://storage.googleapis.com/bucket/secreto-no-loguear-exito.pdf';
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage({ url, expiresAt: new Date() }) as never,
      mockConfig() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(FILA_BASE, 6);

    const todasLasLlamadas = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
    ].flat();
    for (const llamada of todasLasLlamadas) {
      expect(String(llamada)).not.toContain(url);
    }
  });

  it('urlSigned nunca llega al logger en el camino de timeout', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    global.fetch = jest.fn().mockRejectedValue(abortError);
    const url =
      'https://storage.googleapis.com/bucket/secreto-no-loguear-timeout.pdf';
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage({ url, expiresAt: new Date() }) as never,
      mockConfig() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(
      { ...FILA_BASE, attempts: 1 },
      6,
    );

    for (const llamada of warnSpy.mock.calls.flat()) {
      expect(String(llamada)).not.toContain(url);
    }
  });

  it('urlSigned nunca llega al logger en el camino de error de red', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const url =
      'https://storage.googleapis.com/bucket/secreto-no-loguear-red.pdf';
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage({ url, expiresAt: new Date() }) as never,
      mockConfig() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(
      { ...FILA_BASE, attempts: 1 },
      6,
    );

    for (const llamada of warnSpy.mock.calls.flat()) {
      expect(String(llamada)).not.toContain(url);
    }
  });

  // W4.3: `procesar` no debe cachear ni reutilizar la URL firmada entre
  // intentos — cada llamada (cada intento) debe pedir una fresca. Esto es lo
  // que hace que un retry se auto-sane ante una URL vencida (design.md,
  // decisión #3 y el escenario "Expired signed URL triggers a fresh one on
  // retry" de invoice-batch-publication/spec.md).
  it('pide una URL de lectura nueva en cada intento, nunca reutiliza la anterior', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const storage = mockStorage();
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      storage as never,
      mockConfig() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(FILA_BASE, 6);
    await (service as unknown as ServicioConPrivados).procesar(
      { ...FILA_BASE, attempts: 2 },
      6,
    );

    expect(storage.generarUrlLectura).toHaveBeenCalledTimes(2);
    expect(storage.generarUrlLectura).toHaveBeenNthCalledWith(
      1,
      FILA_BASE.objectPath,
      URL_LECTURA_TTL_MS,
    );
    expect(storage.generarUrlLectura).toHaveBeenNthCalledWith(
      2,
      FILA_BASE.objectPath,
      URL_LECTURA_TTL_MS,
    );
  });

  // S2: un 3xx nunca debe seguirse — bajaría el POST a GET y perdería el
  // body firmado.
  it('el fetch de salida no sigue redirecciones (redirect: "error")', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(FILA_BASE, 6);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  // S1: un body de respuesta sin leer puede retener la conexión en undici —
  // `procesar` nunca lee el body (decide todo por el status code), así que
  // debe cancelarlo explícitamente.
  it('cancela el cuerpo de la respuesta cuando existe, para no retener la conexión', async () => {
    const cancelar = jest.fn().mockResolvedValue(undefined);
    global.fetch = jest
      .fn()
      .mockResolvedValue({ status: 201, body: { cancel: cancelar } });
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(FILA_BASE, 6);

    expect(cancelar).toHaveBeenCalledTimes(1);
  });
});

// W4.4: `barrerAgotados` dispara DOS `updateMany` distintos (design.md,
// sección "Sweep"). Un mock que sólo resuelve `{}` no prueba nada sobre
// CUÁLES filas se tocan — esto simula, sobre un array de documentos en
// memoria, el mismo predicado que cada `updateMany` le pide a MongoDB, y
// comprueba que una fila que agotó `max` se cierra en `fallido` terminal
// mientras que una que sigue dentro del presupuesto de intentos queda
// intacta.
describe('PublicacionFacturasService.barrerAgotados', () => {
  function mockFilasConDocumentos(documentos: Record<string, unknown>[]) {
    const estado = documentos.map((d) => ({ ...d }));
    return {
      estado,
      updateMany: jest.fn(
        (
          filtro: Record<string, unknown>,
          update: { $set: Record<string, unknown> },
        ) => ({
          exec: () => {
            const ahora = new Date();
            const vencido = new Date(ahora.getTime() - CLAIM_TTL_MS);
            const max = (filtro.attempts as { $gte: number }).$gte;
            const esLaRamaDeEnviandoVencido = filtro.status === 'enviando';
            let modificados = 0;
            for (const doc of estado) {
              const coincide = esLaRamaDeEnviandoVencido
                ? doc.status === 'enviando' &&
                  doc.claimedAt !== null &&
                  (doc.claimedAt as Date).getTime() <= vencido.getTime() &&
                  (doc.attempts as number) >= max
                : (doc.status === 'pendiente' || doc.status === 'fallido') &&
                  doc.retryable === true &&
                  (doc.attempts as number) >= max;
              if (coincide) {
                Object.assign(doc, update.$set);
                modificados += 1;
              }
            }
            return Promise.resolve({ modifiedCount: modificados });
          },
        }),
      ),
    };
  }

  it('cierra en fallido terminal las filas "enviando" con reclamo vencido que ya agotaron max, sin tocar las que están dentro del presupuesto', async () => {
    jest.useFakeTimers();
    const ahoraFija = new Date('2026-01-01T00:10:00.000Z');
    jest.setSystemTime(ahoraFija);
    const vencidoLimite = new Date(ahoraFija.getTime() - CLAIM_TTL_MS);

    const filaAgotada = {
      ...FILA_BASE,
      status: 'enviando',
      claimedAt: new Date(vencidoLimite.getTime() - 1_000),
      attempts: 6, // >= max: debe cerrarse
      retryable: true,
    };
    const filaDentroDelPresupuesto = {
      ...FILA_BASE,
      status: 'enviando',
      claimedAt: new Date(vencidoLimite.getTime() - 1_000),
      attempts: 3, // < max: NO debe tocarse
      retryable: true,
    };
    const filas = mockFilasConDocumentos([
      filaAgotada,
      filaDentroDelPresupuesto,
    ]);
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await service.barrerAgotados(6);

    expect(filas.estado[0]).toMatchObject({
      status: 'fallido',
      retryable: false,
      lastError: 'reclamo-expirado',
    });
    expect(filas.estado[1]).toMatchObject({ status: 'enviando', attempts: 3 });

    jest.useRealTimers();
  });

  it('cierra en fallido terminal las pendientes/fallidas reintentables que agotaron max (bajado por env), sin tocar las que están dentro del presupuesto', async () => {
    const filaFallidaAgotada = {
      ...FILA_BASE,
      status: 'fallido',
      retryable: true,
      attempts: 6, // >= max: debe cerrarse
    };
    const filaPendienteDentroDelPresupuesto = {
      ...FILA_BASE,
      status: 'pendiente',
      retryable: true,
      attempts: 2, // < max: NO debe tocarse
    };
    const filas = mockFilasConDocumentos([
      filaFallidaAgotada,
      filaPendienteDentroDelPresupuesto,
    ]);
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    await service.barrerAgotados(6);

    expect(filas.estado[0]).toMatchObject({
      status: 'fallido',
      retryable: false,
    });
    expect(filas.estado[1]).toMatchObject({
      status: 'pendiente',
      attempts: 2,
      retryable: true,
    });
  });
});

describe('PublicacionFacturasService.liberar', () => {
  it('un token que ya no coincide (reclamo perdido) no escribe nada y advierte', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const filas = mockFilas({
      updateOne: jest.fn(() => ({
        exec: () => Promise.resolve({ modifiedCount: 0 }),
      })),
    });
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );
    const desenlace: Desenlace = {
      status: 'enviado',
      retryable: false,
      nextAttemptAt: null,
      lastStatusCode: 201,
      lastError: null,
      sentAt: new Date(),
    };

    await service.liberar(FILA_BASE, desenlace);

    expect(filas.updateOne).toHaveBeenCalledTimes(1);
    const [filtro, update] = filas.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(filtro).toEqual({
      _id: FILA_BASE._id,
      claimToken: FILA_BASE.claimToken,
    });
    expect(update.$set).toMatchObject(desenlace);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('PublicacionFacturasService.procesarPendientes — configuración', () => {
  it('sin URL o secreto HMAC configurados, es un no-op (no barre, no reclama)', async () => {
    const filas = mockFilas();
    const config = mockConfig({
      'app.websaco3FacturasEndpointUrl': undefined,
      'app.websaco3HmacSecret': undefined,
      'app.websaco3PublicacionMaxIntentos': 6,
    });
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      config as never,
    );

    const resumen = await service.procesarPendientes();

    expect(resumen).toEqual({
      omitido: false,
      reclamadas: 0,
      enviadas: 0,
      reintentar: 0,
      terminales: 0,
    });
    expect(filas.updateMany).not.toHaveBeenCalled();
    expect(filas.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('PublicacionFacturasService.procesarPendientes — solapamiento', () => {
  it('una segunda llamada concurrente devuelve omitido sin reclamar mientras la primera sigue en curso', async () => {
    const filas = mockFilas();
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    const primera = service.procesarPendientes();
    const segunda = service.procesarPendientes();
    const [resultado1, resultado2] = await Promise.all([primera, segunda]);

    expect(resultado1.omitido).toBe(false);
    expect(resultado2).toEqual({
      omitido: true,
      reclamadas: 0,
      enviadas: 0,
      reintentar: 0,
      terminales: 0,
    });
  });
});

describe('PublicacionFacturasService.procesarPendientes — presupuesto de ciclo', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('deja de reclamar filas nuevas una vez que el presupuesto se agotaría, dejando el resto reclamable para el próximo ciclo', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    let llamadasReclamar = 0;
    const filas = mockFilas({
      findOneAndUpdate: jest.fn(() => {
        llamadasReclamar += 1;
        return {
          lean: () => ({
            exec: () =>
              Promise.resolve({
                ...FILA_BASE,
                claimToken: `token-${llamadasReclamar}`,
              }),
          }),
        };
      }),
    });
    const storage = {
      generarUrlLectura: jest.fn(() => {
        // Simula que cada intento consume tiempo real del ciclo.
        jest.advanceTimersByTime(40_000);
        return Promise.resolve({
          url: 'https://storage.googleapis.com/bucket/lote.pdf',
          expiresAt: new Date(),
        });
      }),
    };
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });

    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      storage as never,
      mockConfig() as never,
    );

    const resumen = await service.procesarPendientes();

    expect(llamadasReclamar).toBeGreaterThan(0);
    expect(llamadasReclamar).toBeLessThan(LOTE_MAXIMO_POR_CICLO);
    expect(resumen.reclamadas).toBe(llamadasReclamar);
  });
});

// W4.7: `resumen.enviadas`/`reintentar`/`terminales` (service.ts:398-400) no
// tenían ninguna aserción — sólo `reclamadas` estaba cubierto arriba. Este
// caso mezcla los tres desenlaces posibles en un mismo ciclo y comprueba que
// cada contador cuenta exactamente lo suyo, no sólo el total.
describe('PublicacionFacturasService.procesarPendientes — contadores del resumen', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('cuenta enviadas, reintentar y terminales por separado cuando el ciclo mezcla los tres desenlaces', async () => {
    const filasParaReclamar = [
      { ...FILA_BASE, claimToken: 'tok-enviado', attempts: 1 },
      { ...FILA_BASE, claimToken: 'tok-reintentar', attempts: 1 },
      { ...FILA_BASE, claimToken: 'tok-terminal', attempts: 1 },
    ];
    let indiceReclamo = 0;
    const filas = mockFilas({
      findOneAndUpdate: jest.fn(() => ({
        lean: () => ({
          exec: () => {
            const fila = filasParaReclamar[indiceReclamo];
            indiceReclamo += 1;
            return Promise.resolve(fila ?? null);
          },
        }),
      })),
    });

    // 201 → enviado; 502 (attempts 1 < max 6) → fallido reintentable;
    // 401 → fallido terminal, sin importar attempts.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 502 })
      .mockResolvedValueOnce({ status: 401 });

    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
    );

    const resumen = await service.procesarPendientes();

    expect(resumen).toEqual({
      omitido: false,
      reclamadas: 3,
      enviadas: 1,
      reintentar: 1,
      terminales: 1,
    });
  });
});

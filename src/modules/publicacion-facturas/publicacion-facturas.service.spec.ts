import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  PublicacionFacturasService,
  type Desenlace,
  type FilaReclamada,
} from './publicacion-facturas.service';
import { LOTE_MAXIMO_POR_CICLO } from './publicacion-facturas.politica';
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

  it('urlSigned nunca llega al logger, ni en éxito ni en fallo', async () => {
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

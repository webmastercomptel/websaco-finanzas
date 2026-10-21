import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { createHmac } from 'node:crypto';
import {
  PublicacionFacturasService,
  type Desenlace,
  type FilaReclamada,
} from './publicacion-facturas.service';
import {
  CLAIM_TTL_MS,
  FETCH_TIMEOUT_MS,
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

const WEBSACO3_ID = '507f1f77bcf86cd799439099';

/** A coproperty that publishes: flag on and the WebSaco3 id on file. */
const COPROPIEDAD_HABILITADA = {
  usaGestionEdificios: true,
  websaco3CopropiedadId: WEBSACO3_ID,
};

const mockCopropiedades = (documento: Record<string, unknown> | null) => {
  const select = jest.fn(() => ({
    lean: () => ({ exec: () => Promise.resolve(documento) }),
  }));
  return { select, findById: jest.fn(() => ({ select })) };
};

/** `findById(...).select(...).lean().exec()` rejects — Mongo unreachable. */
const mockCopropiedadesQueRompe = (error: Error = new Error('mongo down')) => ({
  findById: jest.fn(() => ({
    select: () => ({
      lean: () => ({ exec: () => Promise.reject(error) }),
    }),
  })),
});

/** `findOne(...).select(...).lean().exec()` of a lote; `periodoDesde` defaults to
 *  a November lote (bare date, UTC midnight, as Finanzas stores it). */
const mockLotes = (
  documento: Record<string, unknown> | null = {
    periodoDesde: new Date('2026-11-01T00:00:00.000Z'),
  },
) => {
  const select = jest.fn(() => ({
    lean: () => ({ exec: () => Promise.resolve(documento) }),
  }));
  return { select, findOne: jest.fn(() => ({ select })) };
};

/** The lote read rejects — Mongo unreachable. */
const mockLotesQueRompe = (error: Error = new Error('mongo down')) => ({
  findOne: jest.fn(() => ({
    select: () => ({
      lean: () => ({ exec: () => Promise.reject(error) }),
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
  copropiedadId: new Types.ObjectId('507f1f77bcf86cd799439011'),
  loteId: new Types.ObjectId('507f1f77bcf86cd799439012'),
  numerosFactura: ['FV-1', 'FV-2'],
  objectPath: 'coproprietats/cop-1/lotes/lote-1.pdf',
  estado: 'enviando',
  reintentable: true,
  intentos: 1,
  proximoIntentoEn: null,
  reclamadoEn: new Date(),
  tokenReclamo: 'token-1',
  ultimoCodigoEstado: null,
  ultimoError: null,
  enviadoEn: null,
};

const COPROPERTY_ID = '507f1f77bcf86cd799439011';
const LOTE_ID = '507f1f77bcf86cd799439012';

const EVENTO: LoteFacturasPdfConfirmadoEvent = {
  copropiedadId: COPROPERTY_ID,
  loteId: LOTE_ID,
  objectPath: 'coproprietats/cop-1/lotes/lote-1.pdf',
  numerosFactura: ['FV-1', 'FV-2'],
};

describe('PublicacionFacturasService.encolar', () => {
  const crearServicio = (
    copropiedad: Record<string, unknown> | null,
    filas = mockFilas(),
  ) =>
    new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(copropiedad) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

  it('la copropiedad con el flag apagado no escribe ninguna fila y devuelve false', async () => {
    const filas = mockFilas();
    const service = crearServicio(
      { usaGestionEdificios: false, websaco3CopropiedadId: null },
      filas,
    );

    await expect(service.encolar(EVENTO)).resolves.toBe(false);

    expect(filas.updateOne).not.toHaveBeenCalled();
  });

  it('una copropiedad inexistente no escribe ninguna fila y devuelve false', async () => {
    const filas = mockFilas();
    const service = crearServicio(null, filas);

    await expect(service.encolar(EVENTO)).resolves.toBe(false);

    expect(filas.updateOne).not.toHaveBeenCalled();
  });

  it('el flag activo sin websaco3CopropiedadId no escribe, advierte y devuelve false', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const filas = mockFilas();
    const service = crearServicio(
      { usaGestionEdificios: true, websaco3CopropiedadId: null },
      filas,
    );

    await expect(service.encolar(EVENTO)).resolves.toBe(false);

    expect(filas.updateOne).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain(LOTE_ID);
    warnSpy.mockRestore();
  });

  it('lee solo el flag y el id de la copropiedad (sin nit)', async () => {
    const copropiedades = mockCopropiedades({
      usaGestionEdificios: true,
      websaco3CopropiedadId: WEBSACO3_ID,
    });
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      copropiedades as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await service.encolar(EVENTO);

    expect(copropiedades.select).toHaveBeenCalledWith(
      'usaGestionEdificios websaco3CopropiedadId',
    );
  });

  it('hace upsert con $setOnInsert (sin nit) y devuelve true cuando el flag y el id están completos', async () => {
    const filas = mockFilas();
    const service = crearServicio(
      { usaGestionEdificios: true, websaco3CopropiedadId: WEBSACO3_ID },
      filas,
    );

    await expect(service.encolar(EVENTO)).resolves.toBe(true);

    expect(filas.updateOne).toHaveBeenCalledTimes(1);
    const [filtro, update, opciones] = filas.updateOne.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(opciones).toEqual({ upsert: true });
    expect(update.$setOnInsert).toMatchObject({
      numerosFactura: ['FV-1', 'FV-2'],
      objectPath: EVENTO.objectPath,
      estado: 'pendiente',
      reintentable: true,
      intentos: 0,
    });
    expect(update.$setOnInsert).not.toHaveProperty('nit');
    expect(update.$setOnInsert).not.toHaveProperty('websaco3CopropiedadId');
    expect(filtro).toHaveProperty('loteId');
  });

  it('un E11000 (carrera de upserts concurrentes) se traga como no-op y devuelve true (la fila existe)', async () => {
    const error = Object.assign(new Error('duplicate key'), { code: 11000 });
    const filas = mockFilas({
      updateOne: jest.fn(() => ({ exec: () => Promise.reject(error) })),
    });
    const service = crearServicio(
      { usaGestionEdificios: true, websaco3CopropiedadId: WEBSACO3_ID },
      filas,
    );

    await expect(service.encolar(EVENTO)).resolves.toBe(true);
  });

  it('un error que NO es E11000 se propaga', async () => {
    const filas = mockFilas({
      updateOne: jest.fn(() => ({
        exec: () => Promise.reject(new Error('mongo down')),
      })),
    });
    const service = crearServicio(
      { usaGestionEdificios: true, websaco3CopropiedadId: WEBSACO3_ID },
      filas,
    );

    await expect(service.encolar(EVENTO)).rejects.toThrow('mongo down');
  });
});

describe('PublicacionFacturasService.reclamar', () => {
  it('arma el filtro/update atómico exacto, incluyendo la rama de enviando vencido y el guard intentos<max', async () => {
    const filas = mockFilas();
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await service.reclamar(6);

    expect(filas.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro, update, opciones] = filas.findOneAndUpdate.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect(filtro.intentos).toEqual({ $lt: 6 });
    const or = filtro.$or as Record<string, unknown>[];
    expect(or).toHaveLength(2);
    expect(or[0]).toMatchObject({
      estado: { $in: ['pendiente', 'fallido'] },
      reintentable: true,
    });
    expect(or[0]).toHaveProperty('proximoIntentoEn');
    expect(or[1]).toMatchObject({ estado: 'enviando' });
    expect(or[1]).toHaveProperty('reclamadoEn');

    expect((update.$set as Record<string, unknown>).estado).toBe('enviando');
    expect(update.$inc).toEqual({ intentos: 1 });
    expect(opciones).toMatchObject({
      sort: { proximoIntentoEn: 1 },
      returnDocument: 'after',
    });
  });

  it('sin loteId, el filtro no restringe por lote (el barrido reclama cualquier fila elegible)', async () => {
    const filas = mockFilas();
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await service.reclamar(6);

    const [filtro] = filas.findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(filtro).not.toHaveProperty('loteId');
  });

  it('con loteId, agrega el filtro por ese lote y conserva el mismo reclamo atómico', async () => {
    const filas = mockFilas();
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await service.reclamar(6, LOTE_ID);

    expect(filas.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro, update, opciones] = filas.findOneAndUpdate.mock
      .calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    expect(filtro.loteId).toEqual(new Types.ObjectId(LOTE_ID));
    // Same eligibility predicate as the sweep: the filter narrows, it never
    // replaces it, so an exhausted or already-claimed row is still skipped.
    expect(filtro.intentos).toEqual({ $lt: 6 });
    expect(filtro.$or as unknown[]).toHaveLength(2);
    expect((update.$set as Record<string, unknown>).estado).toBe('enviando');
    expect(update.$inc).toEqual({ intentos: 1 });
    expect(opciones).toMatchObject({ returnDocument: 'after' });
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
   *  en memoria: `intentos < max` Y (pendiente/fallido reintentable due, O
   *  enviando con reclamadoEn <= vencido). */
  function coincideFiltroDeReclamo(
    fila: FilaReclamada,
    max: number,
    ahora: Date,
    vencido: Date,
  ): boolean {
    if (!(fila.intentos < max)) return false;
    const ramaDisponible =
      (fila.estado === 'pendiente' || fila.estado === 'fallido') &&
      fila.reintentable === true &&
      fila.proximoIntentoEn !== null &&
      fila.proximoIntentoEn.getTime() <= ahora.getTime();
    const ramaEnviandoVencido =
      fila.estado === 'enviando' &&
      fila.reclamadoEn !== null &&
      fila.reclamadoEn.getTime() <= vencido.getTime();
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
      findOneAndUpdate: jest.fn((filtro: { intentos: { $lt: number } }) => ({
        lean: () => ({
          exec: () => {
            const ahora = new Date();
            const vencido = new Date(ahora.getTime() - CLAIM_TTL_MS);
            const max = filtro.intentos.$lt;
            if (!coincideFiltroDeReclamo(estado, max, ahora, vencido)) {
              return Promise.resolve(null);
            }
            intentoToken += 1;
            estado = {
              ...estado,
              estado: 'enviando',
              reclamadoEn: ahora,
              tokenReclamo: `token-${intentoToken}`,
              intentos: estado.intentos + 1,
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
      estado: 'pendiente',
      reintentable: true,
      intentos: 0,
      proximoIntentoEn: new Date(Date.now() - 1_000),
      reclamadoEn: null,
      tokenReclamo: null,
    };
    const filas = mockFilasSimuladas(filaDisponible);
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    const primeraReclamada = await service.reclamar(6);
    const segundaReclamada = await service.reclamar(6);

    expect(primeraReclamada).not.toBeNull();
    expect(primeraReclamada?.estado).toBe('enviando');
    expect(segundaReclamada).toBeNull();
  });

  it('una fila reclamada hace más tiempo que CLAIM_TTL_MS es reclamable de nuevo', async () => {
    jest.useFakeTimers();
    const ahoraFija = new Date('2026-01-01T00:10:00.000Z');
    jest.setSystemTime(ahoraFija);
    const vencidoLimite = new Date(ahoraFija.getTime() - CLAIM_TTL_MS);

    const filaVieja: FilaReclamada = {
      ...FILA_BASE,
      estado: 'enviando',
      reclamadoEn: new Date(vencidoLimite.getTime() - 1), // 1ms más viejo: vencido
      tokenReclamo: 'reclamo-viejo',
      intentos: 1,
    };
    const filas = mockFilasSimuladas(filaVieja);
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    const reclamada = await service.reclamar(6);

    expect(reclamada).not.toBeNull();
    expect(reclamada?.estado).toBe('enviando');

    jest.useRealTimers();
  });

  it('el borde exacto del TTL (reclamadoEn == vencido) es reclamable; 1ms más nuevo no lo es', async () => {
    jest.useFakeTimers();
    const ahoraFija = new Date('2026-01-01T00:10:00.000Z');
    jest.setSystemTime(ahoraFija);
    const vencidoLimite = new Date(ahoraFija.getTime() - CLAIM_TTL_MS);

    const filaJustoEnElLimite: FilaReclamada = {
      ...FILA_BASE,
      estado: 'enviando',
      reclamadoEn: vencidoLimite, // == vencido → $lte lo incluye
      tokenReclamo: 'limite-exacto',
      intentos: 1,
    };
    const filasEnLimite = mockFilasSimuladas(filaJustoEnElLimite);
    const serviceEnLimite = new PublicacionFacturasService(
      filasEnLimite as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );
    await expect(serviceEnLimite.reclamar(6)).resolves.not.toBeNull();

    const filaMasReciente: FilaReclamada = {
      ...FILA_BASE,
      estado: 'enviando',
      reclamadoEn: new Date(vencidoLimite.getTime() + 1), // 1ms más nuevo: no vencido
      tokenReclamo: 'mas-reciente',
      intentos: 1,
    };
    const filasReciente = mockFilasSimuladas(filaMasReciente);
    const serviceReciente = new PublicacionFacturasService(
      filasReciente as never,
      mockCopropiedades(null) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
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
        mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
        mockStorage() as never,
        mockConfig() as never,
        mockLotes() as never,
      );

      const desenlace = await (
        service as unknown as ServicioConPrivados
      ).procesar(FILA_BASE, 6);

      expect(desenlace.estado).toBe('enviado');
      expect(desenlace.reintentable).toBe(false);
      expect(desenlace.ultimoCodigoEstado).toBe(status);
      expect(desenlace.enviadoEn).toBeInstanceOf(Date);
    },
  );

  it.each([422, 502])(
    'HTTP %i clasifica como fallido reintentable (intentos < max)',
    async (status) => {
      global.fetch = jest.fn().mockResolvedValue({ status });
      const service = new PublicacionFacturasService(
        mockFilas() as never,
        mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
        mockStorage() as never,
        mockConfig() as never,
        mockLotes() as never,
      );

      const desenlace = await (
        service as unknown as ServicioConPrivados
      ).procesar({ ...FILA_BASE, intentos: 1 }, 6);

      expect(desenlace.estado).toBe('fallido');
      expect(desenlace.reintentable).toBe(true);
      expect(desenlace.proximoIntentoEn).toBeInstanceOf(Date);
      expect(desenlace.ultimoError).toBe(`HTTP ${status}`);
    },
  );

  it('un fallido reintentable que ya agotó max queda terminal', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 502 });
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, intentos: 6 }, 6);

    expect(desenlace.estado).toBe('fallido');
    expect(desenlace.reintentable).toBe(false);
    expect(desenlace.proximoIntentoEn).toBeNull();
  });

  it.each([401, 403])(
    'HTTP %i clasifica como fallido terminal',
    async (status) => {
      global.fetch = jest.fn().mockResolvedValue({ status });
      const service = new PublicacionFacturasService(
        mockFilas() as never,
        mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
        mockStorage() as never,
        mockConfig() as never,
        mockLotes() as never,
      );

      const desenlace = await (
        service as unknown as ServicioConPrivados
      ).procesar(FILA_BASE, 6);

      expect(desenlace.estado).toBe('fallido');
      expect(desenlace.reintentable).toBe(false);
      expect(desenlace.ultimoError).toBe(`HTTP ${status}`);
    },
  );

  it('un timeout de fetch clasifica como fallido reintentable', async () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    global.fetch = jest.fn().mockRejectedValue(abortError);
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, intentos: 1 }, 6);

    expect(desenlace.estado).toBe('fallido');
    expect(desenlace.reintentable).toBe(true);
    expect(desenlace.ultimoError).toBe('timeout');
  });

  it('un error de red clasifica como fallido reintentable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, intentos: 1 }, 6);

    expect(desenlace.estado).toBe('fallido');
    expect(desenlace.reintentable).toBe(true);
    expect(desenlace.ultimoError).toBe('red');
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
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      storageQueRompe as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, intentos: 1 }, 6);

    expect(desenlace.estado).toBe('fallido');
    expect(desenlace.reintentable).toBe(true);
    expect(desenlace.ultimoError).toBe('url-firmada');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('urlSigned nunca llega al logger en el camino de fallo reintentable (HTTP 422)', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    global.fetch = jest.fn().mockResolvedValue({ status: 422 });
    const url = 'https://storage.googleapis.com/bucket/secreto-no-loguear.pdf';
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage({ url, expiresAt: new Date() }) as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(
      { ...FILA_BASE, intentos: 1 },
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
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage({ url, expiresAt: new Date() }) as never,
      mockConfig() as never,
      mockLotes() as never,
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
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage({ url, expiresAt: new Date() }) as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(
      { ...FILA_BASE, intentos: 1 },
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
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage({ url, expiresAt: new Date() }) as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(
      { ...FILA_BASE, intentos: 1 },
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
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      storage as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(FILA_BASE, 6);
    await (service as unknown as ServicioConPrivados).procesar(
      { ...FILA_BASE, intentos: 2 },
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
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
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
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await (service as unknown as ServicioConPrivados).procesar(FILA_BASE, 6);

    expect(cancelar).toHaveBeenCalledTimes(1);
  });
});

// `id-resolved-from-current-coproperty`: `procesar` lee el id de la
// `Copropiedad` ACTUAL en cada intento (la fila no lo congela), antes de
// firmar nada. Sin id no hay forma de enviar: terminal, sin URL firmada y sin
// `fetch`. Si la lectura misma falla, es transitorio y se reintenta.
describe('PublicacionFacturasService.procesar — id resuelto desde la copropiedad actual', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const crear = (
    copropiedades: unknown,
    storage: ReturnType<typeof mockStorage> = mockStorage(),
  ) =>
    new PublicacionFacturasService(
      mockFilas() as never,
      copropiedades as never,
      storage as never,
      mockConfig() as never,
      mockLotes() as never,
    );

  const procesar = (
    service: PublicacionFacturasService,
    fila: FilaReclamada = FILA_BASE,
    max = 6,
  ) => (service as unknown as ServicioConPrivados).procesar(fila, max);

  const cuerpoEnviado = (): Record<string, unknown> => {
    const [, opciones] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { body: string },
    ];
    return JSON.parse(opciones.body) as Record<string, unknown>;
  };

  it('lee la copropiedad de la fila, con flag e id, antes de firmar', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const copropiedades = mockCopropiedades(COPROPIEDAD_HABILITADA);
    const service = crear(copropiedades);

    await procesar(service);

    expect(copropiedades.findById).toHaveBeenCalledWith(
      FILA_BASE.copropiedadId,
    );
    expect(copropiedades.select).toHaveBeenCalledWith(
      'usaGestionEdificios websaco3CopropiedadId',
    );
  });

  it('el payload lleva el id actual de la copropiedad (una corrección alcanza filas ya encoladas)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const idCorregido = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const service = crear(
      mockCopropiedades({
        usaGestionEdificios: true,
        websaco3CopropiedadId: idCorregido,
      }),
    );

    await procesar(service);

    expect(cuerpoEnviado()).toMatchObject({
      websaco3CopropiedadId: idCorregido,
      loteId: LOTE_ID,
    });
  });

  it('una fila legacy con nit y sin id: se envía el id de la copropiedad y ningún nit', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const filaLegacy = { ...FILA_BASE, nit: '900123456' } as FilaReclamada;
    const service = crear(mockCopropiedades(COPROPIEDAD_HABILITADA));

    const desenlace = await procesar(service, filaLegacy);

    expect(desenlace.estado).toBe('enviado');
    const cuerpo = cuerpoEnviado();
    expect(cuerpo.websaco3CopropiedadId).toBe(WEBSACO3_ID);
    expect(cuerpo).not.toHaveProperty('nit');
    const [, opciones] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(opciones.body).not.toContain('900123456');
  });

  it.each([
    ['sin id', { usaGestionEdificios: true, websaco3CopropiedadId: null }],
    [
      'con flag apagado (aunque conserve un id)',
      { usaGestionEdificios: false, websaco3CopropiedadId: WEBSACO3_ID },
    ],
    ['inexistente', null],
  ])(
    'copropiedad %s: fallido terminal sin-websaco3-id, sin URL firmada y sin fetch',
    async (_caso, copropiedad) => {
      global.fetch = jest.fn();
      const storage = mockStorage();
      const service = crear(mockCopropiedades(copropiedad), storage);

      // intentos 1 < max 6: NO es agotamiento, es terminal por falta de dato.
      const desenlace = await procesar(service, { ...FILA_BASE, intentos: 1 });

      expect(desenlace).toMatchObject({
        estado: 'fallido',
        reintentable: false,
        proximoIntentoEn: null,
        ultimoCodigoEstado: null,
        ultimoError: 'sin-websaco3-id',
        enviadoEn: null,
      });
      expect(storage.generarUrlLectura).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('si la lectura de la copropiedad lanza: fallido reintentable copropiedad-lectura, sin URL ni fetch', async () => {
    global.fetch = jest.fn();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const storage = mockStorage();
    const service = crear(mockCopropiedadesQueRompe(), storage);

    const desenlace = await procesar(service, { ...FILA_BASE, intentos: 1 });

    expect(desenlace).toMatchObject({
      estado: 'fallido',
      reintentable: true,
      ultimoCodigoEstado: null,
      ultimoError: 'copropiedad-lectura',
    });
    expect(desenlace.proximoIntentoEn).toBeInstanceOf(Date);
    expect(storage.generarUrlLectura).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('si la lectura lanza y ya se agotó max, queda terminal (no se atasca en enviando)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = crear(mockCopropiedadesQueRompe());

    const desenlace = await procesar(service, { ...FILA_BASE, intentos: 6 });

    expect(desenlace).toMatchObject({
      estado: 'fallido',
      reintentable: false,
      proximoIntentoEn: null,
      ultimoError: 'copropiedad-lectura',
    });
  });

  it.each([400, 404])(
    'HTTP %i (id inválido / desconocido en WebSaco3) es fallido terminal, no se reintenta',
    async (status) => {
      global.fetch = jest.fn().mockResolvedValue({ status });
      const service = crear(mockCopropiedades(COPROPIEDAD_HABILITADA));

      const desenlace = await procesar(service, { ...FILA_BASE, intentos: 1 });

      expect(desenlace).toMatchObject({
        estado: 'fallido',
        reintentable: false,
        proximoIntentoEn: null,
        ultimoCodigoEstado: status,
        ultimoError: `HTTP ${status}`,
      });
    },
  );

  // El fetch debe recibir un `AbortSignal` y ABORTARSE tras FETCH_TIMEOUT_MS.
  // El mock respeta la señal igual que undici: rechaza cuando se aborta. Si
  // `signal: controller.signal` se quita de la llamada, el mock nunca se
  // entera del abort y la promesa queda colgada (el test falla por timeout).
  it('el fetch recibe un AbortSignal y se aborta tras FETCH_TIMEOUT_MS: desenlace reintentable por timeout', async () => {
    jest.useFakeTimers();
    try {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      let signalRecibida: AbortSignal | undefined;
      global.fetch = jest.fn(
        (_url: string, opciones: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signalRecibida = opciones.signal;
            opciones.signal?.addEventListener('abort', () =>
              reject(opciones.signal?.reason as Error),
            );
          }),
      ) as unknown as typeof fetch;
      const service = crear(mockCopropiedades(COPROPIEDAD_HABILITADA));

      let desenlace: Desenlace | undefined;
      const pendiente = procesar(service, { ...FILA_BASE, intentos: 1 }).then(
        (d) => {
          desenlace = d;
        },
      );
      // Let `procesar` reach the (never-resolving) fetch.
      await jest.advanceTimersByTimeAsync(0);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(signalRecibida).toBeInstanceOf(AbortSignal);
      expect(signalRecibida?.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
      expect(signalRecibida?.aborted).toBe(false);
      expect(desenlace).toBeUndefined();

      await jest.advanceTimersByTimeAsync(1);
      await pendiente;

      expect(signalRecibida?.aborted).toBe(true);
      expect(desenlace).toMatchObject({
        estado: 'fallido',
        reintentable: true,
        ultimoError: 'timeout',
      });
      expect(desenlace?.proximoIntentoEn).toBeInstanceOf(Date);
    } finally {
      jest.useRealTimers();
    }
  });

  // La firma se recalcula AQUÍ con node:crypto, de forma independiente a
  // `firmar`, sobre el string EXACTO que recibió fetch. Si el servicio
  // re-serializara el body (p. ej. `body: JSON.stringify(payload)` por
  // segunda vez, con otro orden de claves o espacios) o firmara otra cosa,
  // el HMAC calculado sobre `opciones.body` dejaría de coincidir.
  it('envía X-Websaco-Timestamp y X-Websaco-Signature = HMAC-SHA256(secreto, `${timestamp}.${body}`) sobre el body exacto', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const service = crear(mockCopropiedades(COPROPIEDAD_HABILITADA));

    await procesar(service);

    const [, opciones] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    const timestamp = opciones.headers['X-Websaco-Timestamp'];
    const firma = opciones.headers['X-Websaco-Signature'];

    expect(timestamp).toMatch(/^\d+$/);
    expect(firma).toMatch(/^sha256=[0-9a-f]{64}$/);

    const esperada = createHmac(
      'sha256',
      String(CONFIG_COMPLETA['app.websaco3HmacSecret']),
    )
      .update(`${timestamp}.${opciones.body}`, 'utf8')
      .digest('hex');
    expect(firma).toBe(`sha256=${esperada}`);

    const cuerpo = JSON.parse(opciones.body) as Record<string, unknown>;
    expect(cuerpo.websaco3CopropiedadId).toBe(WEBSACO3_ID);
    expect(cuerpo).not.toHaveProperty('nit');
    expect(opciones.body).not.toContain('"nit"');
  });

  it('el id de la copropiedad nunca llega al logger de los caminos terminales', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    global.fetch = jest.fn().mockResolvedValue({ status: 404 });
    const service = crear(mockCopropiedades(COPROPIEDAD_HABILITADA));

    await procesar(service);

    // Not a secret like `urlSigned`, but there is no reason to log it either:
    // the loteId identifies the row, and the id lives on the Copropiedad.
    for (const llamada of warnSpy.mock.calls.flat()) {
      expect(String(llamada)).not.toContain(WEBSACO3_ID);
    }
  });
});

// `immediate-dispatch-on-confirmation`: `publicarAhora` envía LA fila de un
// lote dentro del request de confirmación. Reutiliza el reclamo atómico, así
// que la exclusividad frente al barrido manual es la de `reclamar`.
describe('PublicacionFacturasService.procesar — periodo del lote', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const crear = (lotes: unknown, storage = mockStorage()) =>
    new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      storage as never,
      mockConfig() as never,
      lotes as never,
    );

  const procesar = (service: PublicacionFacturasService, max = 6) =>
    (service as unknown as ServicioConPrivados).procesar(FILA_BASE, max);

  const cuerpoEnviado = (): Record<string, unknown> => {
    const [, opciones] = (global.fetch as jest.Mock).mock.calls[0] as [
      string,
      { body: string },
    ];
    return JSON.parse(opciones.body) as Record<string, unknown>;
  };

  it('lee el lote acotado por la copropiedad de la fila (nunca un findById pelado)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const lotes = mockLotes();

    await procesar(crear(lotes));

    expect(lotes.findOne).toHaveBeenCalledWith({
      _id: FILA_BASE.loteId,
      copropiedadId: FILA_BASE.copropiedadId,
    });
    expect(lotes.select).toHaveBeenCalledWith('periodoDesde');
  });

  it('el payload lleva el periodo AAAA-MM del periodoDesde del lote', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });

    const desenlace = await procesar(crear(mockLotes()));

    expect(desenlace.estado).toBe('enviado');
    expect(cuerpoEnviado().periodo).toBe('2026-11');
  });

  it('usa el mes UTC en el límite de mes (el día 1 UTC no retrocede por la zona de Bogotá)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const service = crear(
      mockLotes({ periodoDesde: new Date('2026-12-01T00:00:00.000Z') }),
    );

    await procesar(service);

    expect(cuerpoEnviado().periodo).toBe('2026-12');
  });

  it.each([
    ['el lote no existe o es de otra copropiedad', null],
    ['el lote no tiene fecha', {}],
  ])('si %s, omite periodo y envía igual', async (_caso, lote) => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });

    const desenlace = await procesar(crear(mockLotes(lote)));

    expect(desenlace.estado).toBe('enviado');
    expect(cuerpoEnviado()).not.toHaveProperty('periodo');
  });

  it('un error al leer el lote es reintentable, sin firmar ni enviar', async () => {
    global.fetch = jest.fn();
    const storage = mockStorage();

    const desenlace = await procesar(crear(mockLotesQueRompe(), storage), 6);

    expect(desenlace.estado).toBe('fallido');
    expect(desenlace.reintentable).toBe(true);
    expect(desenlace.ultimoError).toBe('lote-lectura');
    expect(desenlace.proximoIntentoEn).toBeInstanceOf(Date);
    expect(storage.generarUrlLectura).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('un error al leer el lote con intentos agotados queda terminal', async () => {
    global.fetch = jest.fn();
    const service = crear(mockLotesQueRompe());

    const desenlace = await (
      service as unknown as ServicioConPrivados
    ).procesar({ ...FILA_BASE, intentos: 6 }, 6);

    expect(desenlace.estado).toBe('fallido');
    expect(desenlace.reintentable).toBe(false);
    expect(desenlace.proximoIntentoEn).toBeNull();
  });

  it('una copropiedad sin id de WebSaco3 no lee el lote', async () => {
    global.fetch = jest.fn();
    const lotes = mockLotes();
    const service = new PublicacionFacturasService(
      mockFilas() as never,
      mockCopropiedades({
        usaGestionEdificios: true,
        websaco3CopropiedadId: null,
      }) as never,
      mockStorage() as never,
      mockConfig() as never,
      lotes as never,
    );

    const desenlace = await procesar(service);

    expect(desenlace.ultimoError).toBe('sin-websaco3-id');
    expect(lotes.findOne).not.toHaveBeenCalled();
  });
});

describe('PublicacionFacturasService.publicarAhora', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  /** `findOneAndUpdate` que entrega `fila` (o null) como reclamo. */
  const filasQueReclaman = (fila: FilaReclamada | null) =>
    mockFilas({
      findOneAndUpdate: jest.fn(() => ({
        lean: () => ({ exec: () => Promise.resolve(fila) }),
      })),
    });

  const crear = (
    filas: ReturnType<typeof mockFilas>,
    config: Record<string, unknown> = CONFIG_COMPLETA,
    storage: ReturnType<typeof mockStorage> = mockStorage(),
  ) =>
    new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      storage as never,
      mockConfig(config) as never,
      mockLotes() as never,
    );

  it.each([
    ['sin URL', { ...CONFIG_COMPLETA, 'app.websaco3FacturasEndpointUrl': '' }],
    [
      'sin secreto HMAC',
      { ...CONFIG_COMPLETA, 'app.websaco3HmacSecret': undefined },
    ],
  ])(
    'transporte no configurado (%s): no reclama, no firma y no envía; la fila queda pendiente',
    async (_caso, config) => {
      global.fetch = jest.fn();
      const filas = filasQueReclaman(FILA_BASE);
      const storage = mockStorage();
      const service = crear(filas, config, storage);

      await service.publicarAhora(LOTE_ID);

      expect(filas.findOneAndUpdate).not.toHaveBeenCalled();
      expect(filas.updateOne).not.toHaveBeenCalled();
      expect(storage.generarUrlLectura).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it('reclama con el loteId recibido y el max configurado', async () => {
    global.fetch = jest.fn();
    const filas = filasQueReclaman(null);
    const service = crear(filas);

    await service.publicarAhora(LOTE_ID);

    expect(filas.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro] = filas.findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(filtro.loteId).toEqual(new Types.ObjectId(LOTE_ID));
    expect(filtro.intentos).toEqual({ $lt: 6 });
  });

  it('un reclamo null (ya enviada, ya reclamada, agotada o no vencida) no firma, no envía y no libera nada', async () => {
    global.fetch = jest.fn();
    const filas = filasQueReclaman(null);
    const storage = mockStorage();
    const service = crear(filas, CONFIG_COMPLETA, storage);

    await expect(service.publicarAhora(LOTE_ID)).resolves.toBeUndefined();

    expect(storage.generarUrlLectura).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(filas.updateOne).not.toHaveBeenCalled();
  });

  it('éxito: envía una vez y libera la fila reclamada como enviado', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const filas = filasQueReclaman(FILA_BASE);
    const service = crear(filas);

    await service.publicarAhora(LOTE_ID);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(filas.updateOne).toHaveBeenCalledTimes(1);
    const [filtro, update] = filas.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    // `liberar` is conditional on the claim token, as in the sweep.
    expect(filtro).toEqual({
      _id: FILA_BASE._id,
      tokenReclamo: FILA_BASE.tokenReclamo,
    });
    expect(update.$set).toMatchObject({
      estado: 'enviado',
      reintentable: false,
      ultimoCodigoEstado: 201,
      reclamadoEn: null,
      tokenReclamo: null,
    });
  });

  it('un timeout del fetch libera la fila como fallido reintentable (no lanza)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    global.fetch = jest.fn().mockRejectedValue(abortError);
    const filas = filasQueReclaman({ ...FILA_BASE, intentos: 1 });
    const service = crear(filas);

    await expect(service.publicarAhora(LOTE_ID)).resolves.toBeUndefined();

    const [, update] = filas.updateOne.mock.calls[0] as unknown as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).toMatchObject({
      estado: 'fallido',
      reintentable: true,
      ultimoError: 'timeout',
    });
    expect(update.$set.proximoIntentoEn).toBeInstanceOf(Date);
  });

  it('un id faltante libera la fila como fallido terminal sin-websaco3-id y no envía', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    global.fetch = jest.fn();
    const filas = filasQueReclaman({ ...FILA_BASE, intentos: 1 });
    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades({
        usaGestionEdificios: true,
        websaco3CopropiedadId: null,
      }) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
    );

    await service.publicarAhora(LOTE_ID);

    expect(global.fetch).not.toHaveBeenCalled();
    const [, update] = filas.updateOne.mock.calls[0] as unknown as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).toMatchObject({
      estado: 'fallido',
      reintentable: false,
      ultimoError: 'sin-websaco3-id',
    });
  });

  it('no usa el candado enEjecucion: corre aunque un barrido manual esté en curso en la misma instancia', async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const filas = filasQueReclaman(FILA_BASE);
    const service = crear(filas);
    (service as unknown as { enEjecucion: boolean }).enEjecucion = true;

    await service.publicarAhora(LOTE_ID);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(filas.updateOne).toHaveBeenCalledTimes(1);
  });

  it('si liberar falla, el error se propaga (el listener lo traga y el barrido manual recupera la fila vencida)', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    global.fetch = jest.fn().mockResolvedValue({ status: 201 });
    const filas = mockFilas({
      findOneAndUpdate: jest.fn(() => ({
        lean: () => ({ exec: () => Promise.resolve(FILA_BASE) }),
      })),
      updateOne: jest.fn(() => ({
        exec: () => Promise.reject(new Error('mongo down')),
      })),
    });
    const service = crear(filas);

    // Documented behaviour: nothing is swallowed here (the listener's
    // catch-all owns that). The row stays `enviando` until CLAIM_TTL_MS and
    // the manual sweep recovers it.
    await expect(service.publicarAhora(LOTE_ID)).rejects.toThrow('mongo down');
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
            const max = (filtro.intentos as { $gte: number }).$gte;
            const esLaRamaDeEnviandoVencido = filtro.estado === 'enviando';
            let modificados = 0;
            for (const doc of estado) {
              const coincide = esLaRamaDeEnviandoVencido
                ? doc.estado === 'enviando' &&
                  doc.reclamadoEn !== null &&
                  (doc.reclamadoEn as Date).getTime() <= vencido.getTime() &&
                  (doc.intentos as number) >= max
                : (doc.estado === 'pendiente' || doc.estado === 'fallido') &&
                  doc.reintentable === true &&
                  (doc.intentos as number) >= max;
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
      estado: 'enviando',
      reclamadoEn: new Date(vencidoLimite.getTime() - 1_000),
      intentos: 6, // >= max: debe cerrarse
      reintentable: true,
    };
    const filaDentroDelPresupuesto = {
      ...FILA_BASE,
      estado: 'enviando',
      reclamadoEn: new Date(vencidoLimite.getTime() - 1_000),
      intentos: 3, // < max: NO debe tocarse
      reintentable: true,
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
      mockLotes() as never,
    );

    await service.barrerAgotados(6);

    expect(filas.estado[0]).toMatchObject({
      estado: 'fallido',
      reintentable: false,
      ultimoError: 'reclamo-expirado',
    });
    expect(filas.estado[1]).toMatchObject({ estado: 'enviando', intentos: 3 });

    jest.useRealTimers();
  });

  it('cierra en fallido terminal las pendientes/fallidas reintentables que agotaron max (bajado por env), sin tocar las que están dentro del presupuesto', async () => {
    const filaFallidaAgotada = {
      ...FILA_BASE,
      estado: 'fallido',
      reintentable: true,
      intentos: 6, // >= max: debe cerrarse
    };
    const filaPendienteDentroDelPresupuesto = {
      ...FILA_BASE,
      estado: 'pendiente',
      reintentable: true,
      intentos: 2, // < max: NO debe tocarse
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
      mockLotes() as never,
    );

    await service.barrerAgotados(6);

    expect(filas.estado[0]).toMatchObject({
      estado: 'fallido',
      reintentable: false,
    });
    expect(filas.estado[1]).toMatchObject({
      estado: 'pendiente',
      intentos: 2,
      reintentable: true,
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
      mockLotes() as never,
    );
    const desenlace: Desenlace = {
      estado: 'enviado',
      reintentable: false,
      proximoIntentoEn: null,
      ultimoCodigoEstado: 201,
      ultimoError: null,
      enviadoEn: new Date(),
    };

    await service.liberar(FILA_BASE, desenlace);

    expect(filas.updateOne).toHaveBeenCalledTimes(1);
    const [filtro, update] = filas.updateOne.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(filtro).toEqual({
      _id: FILA_BASE._id,
      tokenReclamo: FILA_BASE.tokenReclamo,
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
      mockLotes() as never,
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
      mockLotes() as never,
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
                tokenReclamo: `token-${llamadasReclamar}`,
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
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      storage as never,
      mockConfig() as never,
      mockLotes() as never,
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
      { ...FILA_BASE, tokenReclamo: 'tok-enviado', intentos: 1 },
      { ...FILA_BASE, tokenReclamo: 'tok-reintentar', intentos: 1 },
      { ...FILA_BASE, tokenReclamo: 'tok-terminal', intentos: 1 },
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

    // 201 → enviado; 502 (intentos 1 < max 6) → fallido reintentable;
    // 401 → fallido terminal, sin importar intentos.
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ status: 201 })
      .mockResolvedValueOnce({ status: 502 })
      .mockResolvedValueOnce({ status: 401 });

    const service = new PublicacionFacturasService(
      filas as never,
      mockCopropiedades(COPROPIEDAD_HABILITADA) as never,
      mockStorage() as never,
      mockConfig() as never,
      mockLotes() as never,
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

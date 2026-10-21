import { Logger } from '@nestjs/common';
import { ComptableClient, COMPTABLE_TIMEOUT_MS } from './comptable.client';
import { firmarComptable } from './comptable.firma';

const BASE = 'https://comptable.ejemplo.com/api/v1';
const SECRETO = 'comptable-test-secret-0123456789abcdef';
const EMPRESA = '670000000000000000000001';
const AHORA_MS = 1_792_512_000_000;
const ACTOR = { accountId: '672000000000000000000001', nombre: 'Ana Pérez' };

const mockConfig = (valores: Record<string, unknown>) => ({
  get: jest.fn((clave: string) => valores[clave]),
});

const crearCliente = (
  valores: Record<string, unknown> = {
    'app.comptableApiUrl': BASE,
    'app.comptableHmacSecret': SECRETO,
  },
) => new ComptableClient(mockConfig(valores) as never);

const respuesta = (status: number, cuerpo: unknown) =>
  ({
    status,
    text: () =>
      Promise.resolve(
        typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo),
      ),
  }) as unknown as Response;

type LlamadaFetch = [string, RequestInit];

describe('ComptableClient', () => {
  let fetchMock: jest.SpyInstance;
  let logs: string[];

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(AHORA_MS);
    fetchMock = jest.spyOn(global, 'fetch');
    logs = [];
    const capturar = (mensaje: unknown) => {
      logs.push(String(mensaje));
    };
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capturar);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(capturar);
  });

  afterEach(() => jest.restoreAllMocks());

  const llamada = (): LlamadaFetch => fetchMock.mock.calls[0] as LlamadaFetch;

  describe('firma y transporte', () => {
    it('firma el POST con la ruta completa (incluye /api/v1 y la query) y envía el cuerpo sin tocarlo', async () => {
      fetchMock.mockResolvedValue(
        respuesta(201, { statusCode: 201, data: {} }),
      );
      const rawBody = '{"version":1,"texto":"Pérez"}';

      await crearCliente().enviarLote(EMPRESA, rawBody, false);

      const [url, init] = llamada();
      expect(url).toBe(
        `${BASE}/integraciones/websaco/empresas/${EMPRESA}/lotes?simular=false`,
      );
      expect(init.method).toBe('POST');
      expect(init.body).toBe(rawBody);
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Websaco-Timestamp']).toBe('1792512000');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Websaco-Signature']).toBe(
        `sha256=${firmarComptable(SECRETO, {
          timestamp: '1792512000',
          metodo: 'POST',
          ruta: `/api/v1/integraciones/websaco/empresas/${EMPRESA}/lotes?simular=false`,
          rawBody,
        })}`,
      );
      expect(init.redirect).toBe('error');
    });

    it('reproduce la firma del vector compartido para el GET de la Empresa', async () => {
      fetchMock.mockResolvedValue(
        respuesta(200, { statusCode: 200, data: {} }),
      );

      await crearCliente().consultarEmpresa(EMPRESA);

      const [url, init] = llamada();
      expect(url).toBe(`${BASE}/integraciones/websaco/empresas/${EMPRESA}`);
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBeUndefined();
      expect(headers['X-Websaco-Signature']).toBe(
        'sha256=f48ad5c95606dead9e4909f3b5f4e4008af197db804961cf07531c1d15d067a1',
      );
    });

    it('simular=true viaja en la query firmada', async () => {
      fetchMock.mockResolvedValue(
        respuesta(201, { statusCode: 201, data: {} }),
      );

      await crearCliente().enviarLote(EMPRESA, '{}', true);

      expect(llamada()[0]).toMatch(/lotes\?simular=true$/);
    });

    it('retirar es un POST con { solicitadoPor }, firmado sobre ese cuerpo exacto', async () => {
      fetchMock.mockResolvedValue(
        respuesta(200, { statusCode: 200, data: {} }),
      );

      await crearCliente().retirarLote(
        EMPRESA,
        '671000000000000000000001',
        ACTOR,
      );

      const [url, init] = llamada();
      expect(url).toBe(
        `${BASE}/integraciones/websaco/empresas/${EMPRESA}/lotes/671000000000000000000001/retirar`,
      );
      const rawBody =
        '{"solicitadoPor":{"accountId":"672000000000000000000001","nombre":"Ana Pérez"}}';
      expect(init.method).toBe('POST');
      expect(init.body).toBe(rawBody);
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Websaco-Signature']).toBe(
        `sha256=${firmarComptable(SECRETO, {
          timestamp: '1792512000',
          metodo: 'POST',
          ruta: `/api/v1/integraciones/websaco/empresas/${EMPRESA}/lotes/671000000000000000000001/retirar`,
          rawBody,
        })}`,
      );
    });

    it('tolera una URL base con barra final', async () => {
      fetchMock.mockResolvedValue(
        respuesta(200, { statusCode: 200, data: {} }),
      );

      await crearCliente({
        'app.comptableApiUrl': `${BASE}/`,
        'app.comptableHmacSecret': SECRETO,
      }).consultarEmpresa(EMPRESA);

      expect(llamada()[0]).toBe(
        `${BASE}/integraciones/websaco/empresas/${EMPRESA}`,
      );
    });

    it('aborta a los 60 s', () => {
      expect(COMPTABLE_TIMEOUT_MS).toBe(60_000);
    });
  });

  describe('desenlaces', () => {
    it('noConfigurado: sin URL o sin secreto no hace ninguna petición', async () => {
      expect(await crearCliente({}).consultarEmpresa(EMPRESA)).toEqual({
        tipo: 'noConfigurado',
      });
      expect(crearCliente({}).configurado()).toBe(false);
      expect(crearCliente().configurado()).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('ok: el 200 del retiro desenvuelve { lote, eliminados }', async () => {
      fetchMock.mockResolvedValue(
        respuesta(200, {
          statusCode: 200,
          data: { lote: { id: 'L1', estado: 'retirado' }, eliminados: 2 },
        }),
      );

      expect(await crearCliente().retirarLote(EMPRESA, 'x', ACTOR)).toEqual({
        tipo: 'ok',
        status: 200,
        datos: { lote: { id: 'L1', estado: 'retirado' }, eliminados: 2 },
      });
    });

    it('ok: desenvuelve data', async () => {
      fetchMock.mockResolvedValue(
        respuesta(200, {
          statusCode: 200,
          data: { id: EMPRESA, codigo: '0001', nombre: 'Empresa', nit: '900' },
        }),
      );

      expect(await crearCliente().consultarEmpresa(EMPRESA)).toEqual({
        tipo: 'ok',
        status: 200,
        datos: { id: EMPRESA, codigo: '0001', nombre: 'Empresa', nit: '900' },
      });
    });

    it('rechazado: 400 de validación del DTO (message lista) une los mensajes con "; "', async () => {
      fetchMock.mockResolvedValue(
        respuesta(400, {
          statusCode: 400,
          message: [
            'Solo se acepta la versión 1 del contrato',
            'asientos must contain at least 1 elements',
          ],
          error: 'Bad Request',
        }),
      );

      expect(await crearCliente().enviarLote(EMPRESA, '{}', false)).toEqual({
        tipo: 'rechazado',
        mensaje:
          'Solo se acepta la versión 1 del contrato; asientos must contain at least 1 elements',
        errores: [],
      });
    });

    it('rechazado: 400 con mensaje y errores por asiento', async () => {
      fetchMock.mockResolvedValue(
        respuesta(400, {
          statusCode: 400,
          message: 'El lote tiene errores',
          errores: [{ asiento: 'FV 4152', motivo: 'Cuenta inexistente' }],
        }),
      );

      expect(await crearCliente().enviarLote(EMPRESA, '{}', true)).toEqual({
        tipo: 'rechazado',
        mensaje: 'El lote tiene errores',
        errores: [{ asiento: 'FV 4152', motivo: 'Cuenta inexistente' }],
      });
    });

    it('duplicado: 409 LOTE_YA_RECIBIDO con el loteId existente', async () => {
      fetchMock.mockResolvedValue(
        respuesta(409, {
          statusCode: 409,
          codigo: 'LOTE_YA_RECIBIDO',
          message: 'Este lote ya fue recibido en Comptable (lote L1).',
          loteId: 'L1',
        }),
      );

      expect(await crearCliente().enviarLote(EMPRESA, '{}', false)).toEqual({
        tipo: 'duplicado',
        loteId: 'L1',
        mensaje: 'Este lote ya fue recibido en Comptable (lote L1).',
      });
    });

    it('intervenido: 409 LOTE_INTERVENIDO con el mensaje tal cual', async () => {
      const mensaje =
        'El lote fue modificado en Comptable el 21/10/2026 10:30 por Ana: ya no se puede retirar desde WebSACO Finanzas.';
      fetchMock.mockResolvedValue(
        respuesta(409, {
          statusCode: 409,
          codigo: 'LOTE_INTERVENIDO',
          message: mensaje,
        }),
      );

      expect(await crearCliente().retirarLote(EMPRESA, 'x', ACTOR)).toEqual({
        tipo: 'intervenido',
        mensaje,
      });
    });

    it('yaRetirado: 409 LOTE_YA_RETIRADO', async () => {
      fetchMock.mockResolvedValue(
        respuesta(409, {
          statusCode: 409,
          codigo: 'LOTE_YA_RETIRADO',
          message: 'Este lote ya fue retirado de Comptable',
        }),
      );

      expect(await crearCliente().retirarLote(EMPRESA, 'x', ACTOR)).toEqual({
        tipo: 'yaRetirado',
        mensaje: 'Este lote ya fue retirado de Comptable',
      });
    });

    it('conflicto: otro 409 sin código (mes no abierto)', async () => {
      const mensaje =
        'No se puede retirar el lote: tiene asientos en meses que no están abiertos: 2026-10 (cerrado)';
      fetchMock.mockResolvedValue(
        respuesta(409, {
          statusCode: 409,
          message: mensaje,
          error: 'Conflict',
        }),
      );

      expect(await crearCliente().retirarLote(EMPRESA, 'x', ACTOR)).toEqual({
        tipo: 'conflicto',
        mensaje,
      });
    });

    it('noEncontrado: 404', async () => {
      fetchMock.mockResolvedValue(
        respuesta(404, {
          statusCode: 404,
          message: 'No existe una empresa activa con ese identificador',
          error: 'Not Found',
        }),
      );

      expect(await crearCliente().consultarEmpresa(EMPRESA)).toEqual({
        tipo: 'noEncontrado',
        mensaje: 'No existe una empresa activa con ese identificador',
      });
    });

    it.each([
      [401, { statusCode: 401, message: 'Unauthorized' }],
      [403, ''],
    ])('firma: %i opaco', async (status, cuerpo) => {
      fetchMock.mockResolvedValue(respuesta(status, cuerpo));

      expect(await crearCliente().consultarEmpresa(EMPRESA)).toEqual({
        tipo: 'firma',
      });
    });

    it('inesperado: 5xx o un cuerpo que no es JSON', async () => {
      fetchMock.mockResolvedValue(respuesta(502, '<html>Bad gateway</html>'));

      expect(await crearCliente().consultarEmpresa(EMPRESA)).toEqual({
        tipo: 'inesperado',
        status: 502,
      });
    });

    it('timeout: la petición abortada', async () => {
      fetchMock.mockRejectedValue(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      );

      expect(await crearCliente().enviarLote(EMPRESA, '{}', false)).toEqual({
        tipo: 'timeout',
      });
    });

    it('red: cualquier otro fallo de fetch', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      expect(await crearCliente().enviarLote(EMPRESA, '{}', false)).toEqual({
        tipo: 'red',
      });
    });
  });

  it('nunca escribe en el log el cuerpo, el secreto ni la firma', async () => {
    const rawBody = '{"secretoDelCuerpo":"no-debe-aparecer"}';
    fetchMock.mockResolvedValueOnce(
      respuesta(400, { message: 'mensaje-del-cuerpo', errores: [] }),
    );
    await crearCliente().enviarLote(EMPRESA, rawBody, false);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await crearCliente().enviarLote(EMPRESA, rawBody, false);

    const firma = firmarComptable(SECRETO, {
      timestamp: '1792512000',
      metodo: 'POST',
      ruta: `/api/v1/integraciones/websaco/empresas/${EMPRESA}/lotes?simular=false`,
      rawBody,
    });
    const todo = logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    expect(todo).not.toContain('no-debe-aparecer');
    expect(todo).not.toContain('mensaje-del-cuerpo');
    expect(todo).not.toContain(SECRETO);
    expect(todo).not.toContain(firma);
    expect(todo).not.toContain(EMPRESA);
  });
});

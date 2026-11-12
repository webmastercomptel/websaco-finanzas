import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  HttpException,
  Logger,
  NotFoundException,
  RequestMethod,
} from '@nestjs/common';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import { PUBLIC_KEY } from '../casl/check-ability.decorator';
import { FacturaPublicaController } from './factura-publica.controller';
import { MENSAJE_OPACO, PISO_DE_TIEMPO_MS } from './factura-publica.constantes';

const TOKEN = 'ab12'.repeat(16);
const IP = '203.0.113.7';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const PDF = new Uint8Array([37, 80, 68, 70]);
const RESUELTO = {
  bytes: PDF,
  numeroCompleto: 'FV-0001',
  enlaceId: 'enl-1',
  envioFacturaId: 'env-1',
};

type Resolucion = typeof RESUELTO | null | Error;

function montar(opciones: { resolucion?: Resolucion; limite?: unknown } = {}) {
  const resolucion = 'resolucion' in opciones ? opciones.resolucion : RESUELTO;
  const servicio = {
    resolver: jest.fn(() =>
      resolucion instanceof Error
        ? Promise.reject(resolucion)
        : Promise.resolve(resolucion),
    ),
  };
  // A real fixed-window counter per key, so limits behave like Redis.
  const contadores = new Map<string, number>();
  const limite = opciones.limite ?? {
    permitir: jest.fn((clave: string, maximo: number) => {
      const n = (contadores.get(clave) ?? 0) + 1;
      contadores.set(clave, n);
      return Promise.resolve(n <= maximo);
    }),
  };
  const res = { set: jest.fn(), send: jest.fn() };
  return {
    servicio,
    limite: limite as { permitir: jest.Mock },
    res,
    controlador: new FacturaPublicaController(
      servicio as never,
      limite as never,
    ),
  };
}

type Montaje = ReturnType<typeof montar>;
const req = (ip: string = IP, extra: object = {}) => ({ ip, ...extra });

/** Runs the handler to its end, advancing fake time past the refusal floor. */
async function correr(
  m: Montaje,
  token: string = TOKEN,
  peticion: object = req(),
) {
  const promesa = m.controlador
    .obtenerPdf({ token }, peticion as never, m.res as never)
    .then(
      () => ({ error: null as unknown }),
      (error: unknown) => ({ error }),
    );
  await jest.advanceTimersByTimeAsync(PISO_DE_TIEMPO_MS);
  return promesa;
}

const cabeceras = (m: Montaje): Record<string, string> =>
  Object.assign(
    {},
    ...m.res.set.mock.calls.map((c) => c[0] as Record<string, string>),
  ) as Record<string, string>;

let registros: jest.SpyInstance[];
const todoLoRegistrado = () =>
  registros
    .flatMap((r) => r.mock.calls as unknown[][])
    .map((c) => JSON.stringify(c))
    .join('\n');

beforeEach(() => {
  jest.useFakeTimers();
  registros = (['error', 'warn', 'log', 'debug', 'verbose'] as const).map((n) =>
    jest.spyOn(Logger.prototype, n).mockImplementation(),
  );
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('FacturaPublicaController — política de ruta', () => {
  const handler = (
    FacturaPublicaController.prototype as unknown as Record<string, object>
  ).obtenerPdf;

  it('es POST /publico/facturas/pdf, @Public, sin guards en clase ni método, y responde 200', () => {
    expect(Reflect.getMetadata(PATH_METADATA, FacturaPublicaController)).toBe(
      'publico/facturas',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('pdf');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, FacturaPublicaController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });
});

describe('FacturaPublicaController.obtenerPdf — éxito', () => {
  it('SEC: success exposes only the PDF — 200, solo los bytes, cabeceras exactas, sin cookie ni sobre', async () => {
    const m = montar();

    const { error } = await correr(m);

    expect(error).toBeNull();
    expect(m.res.send).toHaveBeenCalledTimes(1);
    expect(m.res.send).toHaveBeenCalledWith(Buffer.from(PDF));
    const h = cabeceras(m);
    expect(h).toEqual({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="factura-FV-0001.pdf"',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain(
      'set-cookie',
    );
    expect(m.servicio.resolver).toHaveBeenCalledWith(TOKEN);
  });

  it('SEC: success exposes only the PDF — Authorization y X-CoProperty-Id del cliente se ignoran: solo cuenta el token', async () => {
    const m = montar();

    await correr(
      m,
      TOKEN,
      req(IP, {
        headers: {
          authorization: 'Bearer de-otra-persona',
          'x-coproperty-id': 'copropiedad-ajena',
        },
        user: { copropiedadId: 'copropiedad-ajena' },
      }),
    );

    expect(m.servicio.resolver).toHaveBeenCalledTimes(1);
    expect(m.servicio.resolver).toHaveBeenCalledWith(TOKEN);
    expect(m.res.send).toHaveBeenCalledWith(Buffer.from(PDF));
  });

  it('el nombre de archivo sale solo del número de factura, saneado a [A-Za-z0-9-]', async () => {
    const m = montar({
      resolucion: { ...RESUELTO, numeroCompleto: 'a"b\r\nc/ñ' },
    });

    await correr(m);

    expect(cabeceras(m)['Content-Disposition']).toBe(
      'inline; filename="factura-a-b-c.pdf"',
    );
  });
});

describe('FacturaPublicaController.obtenerPdf — rechazo uniforme', () => {
  const causas: Array<[string, string, Resolucion]> = [
    ['enlace desconocido', TOKEN, null],
    [
      'expirado, revocado, anulada, sin liberar, dirección quitada, sin licencia o sin PDF (el servicio responde null)',
      TOKEN,
      null,
    ],
    [
      'almacenamiento falla con el id de la factura en el mensaje',
      TOKEN,
      new Error(
        'La factura 65f0a1 todavía no tiene una página individual disponible',
      ),
    ],
    [
      'el 404 del personal se cuela desde abajo',
      TOKEN,
      new NotFoundException(
        'La factura 65f0a1 todavía no tiene una página individual disponible',
      ),
    ],
    [
      '500 después de las verificaciones',
      TOKEN,
      new HttpException('boom 65f0a1', 500),
    ],
    ['token mal formado: palabra', 'hola', null],
    ['token vacío', '', null],
    ['64 caracteres no hex', 'z'.repeat(64), null],
  ];

  async function respuestaDe(
    token: string,
    resolucion: Resolucion,
  ): Promise<{ estado: number; cuerpo: unknown; cabeceras: object }> {
    const m = montar({ resolucion });
    const { error } = await correr(m, token);
    expect(error).toBeInstanceOf(HttpException);
    const e = error as HttpException;
    expect(m.res.send).not.toHaveBeenCalled();
    return {
      estado: e.getStatus(),
      cuerpo: e.getResponse(),
      cabeceras: cabeceras(m),
    };
  }

  it('SEC: uniform refusal is byte-identical — misma respuesta (estado, cuerpo, cabeceras) para toda causa', async () => {
    const respuestas = [];
    for (const [, token, resolucion] of causas) {
      respuestas.push(await respuestaDe(token, resolucion));
    }

    for (const r of respuestas) expect(r).toEqual(respuestas[0]);
    expect(respuestas[0].estado).toBe(404);
    expect(respuestas[0].cuerpo).toMatchObject({ message: MENSAJE_OPACO });
    expect(respuestas[0].cabeceras).toMatchObject({
      'Cache-Control': 'no-store',
    });
  });

  it('SEC: no enumeration via status or body — ni el número de factura, ni ids, ni el texto del personal llegan al cliente', async () => {
    for (const [, token, resolucion] of causas) {
      const { cuerpo } = await respuestaDe(token, resolucion);
      const texto = JSON.stringify(cuerpo);
      expect(texto).not.toMatch(/65f0a1|FV-0001|página individual|boom/);
      expect(texto).not.toContain(token === '' ? '\u0000' : token);
    }
  });

  it('un token mal formado no llega al servicio, y no es 400', async () => {
    const m = montar();

    const { error } = await correr(m, 'hola');

    expect((error as HttpException).getStatus()).toBe(404);
    expect(m.servicio.resolver).not.toHaveBeenCalled();
  });

  it('SEC: uniform refusal is byte-identical — ningún rechazo responde antes de 300 ms', async () => {
    for (const [, token, resolucion] of causas) {
      const m = montar({ resolucion });
      let respondio = false;
      const promesa = m.controlador
        .obtenerPdf({ token }, req() as never, m.res as never)
        .catch(() => undefined)
        .then(() => {
          respondio = true;
        });

      await jest.advanceTimersByTimeAsync(PISO_DE_TIEMPO_MS - 1);
      expect(respondio).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await promesa;
      expect(respondio).toBe(true);
    }
  });
});

describe('FacturaPublicaController.obtenerPdf — límites', () => {
  const MENSAJE_429 =
    'Demasiados intentos. Espera un minuto e inténtalo de nuevo.';

  it('SEC: rate limit fails closed, per IP and per token — la 31.ª petición de una IP es 429 y no consulta nada', async () => {
    const m = montar();
    for (let i = 1; i <= 30; i += 1) {
      const t = i.toString(16).padStart(64, '0');
      expect((await correr(m, t)).error).not.toBeInstanceOf(HttpException);
    }
    m.servicio.resolver.mockClear();

    const { error } = await correr(m, 'c'.repeat(64));

    expect((error as HttpException).getStatus()).toBe(429);
    expect((error as HttpException).message).toBe(MENSAJE_429);
    expect(m.servicio.resolver).not.toHaveBeenCalled();
  });

  it('SEC: rate limit fails closed, per IP and per token — la 11.ª con el mismo token es 429 para ese token y otro token sigue atendido', async () => {
    const m = montar();
    for (let i = 0; i < 10; i += 1) await correr(m, TOKEN);

    const bloqueado = await correr(m, TOKEN);
    const otro = await correr(m, 'cd34'.repeat(16));

    expect((bloqueado.error as HttpException).getStatus()).toBe(429);
    expect(otro.error).toBeNull();
  });

  it('SEC: rate limit fails closed, per IP and per token — Redis caído: 429, nunca un PDF', async () => {
    const redis = {
      eval: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const m = montar({ limite: new LimiteIntentosService(redis as never) });

    const { error } = await correr(m);

    expect((error as HttpException).getStatus()).toBe(429);
    expect(m.servicio.resolver).not.toHaveBeenCalled();
    expect(m.res.send).not.toHaveBeenCalled();
  });

  it('SEC: rate limit fails closed, per IP and per token — claves por IP y por hash del token, sin cubo global ni token crudo', async () => {
    const m = montar();

    await correr(m, TOKEN);

    expect(m.limite.permitir.mock.calls).toEqual([
      [`limite:factura-publica:ip:${IP}`, 30, 60_000],
      [`limite:factura-publica:token:${sha256(TOKEN)}`, 10, 60_000],
    ]);
    expect(JSON.stringify(m.limite.permitir.mock.calls)).not.toContain(TOKEN);
  });

  it('un texto mal formado consume el contador de la IP y no crea clave de token', async () => {
    const m = montar();

    await correr(m, 'hola');

    expect(m.limite.permitir.mock.calls).toEqual([
      [`limite:factura-publica:ip:${IP}`, 30, 60_000],
    ]);
  });

  it('una ráfaga de basura desde una IP no afecta a otra IP', async () => {
    const m = montar();
    for (let i = 0; i < 31; i += 1) {
      await correr(m, i.toString(16).padStart(64, 'f'), req('198.51.100.1'));
    }

    const { error } = await correr(m, TOKEN, req('198.51.100.2'));

    expect(error).toBeNull();
  });

  it('el 429 de un token válido es igual al de uno desconocido', async () => {
    const a = montar({ resolucion: RESUELTO });
    const b = montar({ resolucion: null });
    for (let i = 0; i < 10; i += 1) {
      await correr(a, TOKEN);
      await correr(b, TOKEN);
    }

    const ra = (await correr(a, TOKEN)).error as HttpException;
    const rb = (await correr(b, TOKEN)).error as HttpException;

    expect(ra.getStatus()).toBe(429);
    expect(rb.getStatus()).toBe(429);
    expect(ra.getResponse()).toEqual(rb.getResponse());
    expect(cabeceras(a)['Cache-Control']).toBe('no-store');
  });
});

describe('FacturaPublicaController.obtenerPdf — registros', () => {
  it('SEC: token and address never reach a log — servir, rechazar y 429 no registran token, hash, correo, IP ni cuerpo', async () => {
    const exito = montar();
    await correr(exito);
    const rechazo = montar({ resolucion: null });
    await correr(rechazo);
    const falla = montar({ resolucion: new Error(`boom ${TOKEN} ana@x.com`) });
    await correr(falla);
    const limitado = montar();
    for (let i = 0; i < 11; i += 1) await correr(limitado);

    const salida = todoLoRegistrado();
    expect(salida).not.toContain(TOKEN);
    expect(salida).not.toContain(sha256(TOKEN));
    expect(salida).not.toContain('ana@x.com');
    expect(salida).not.toContain(IP);
    expect(salida).not.toContain('FV-0001');
  });

  it('un servicio exitoso se anota con el id del enlace y el del envío, nada más', async () => {
    const m = montar();

    await correr(m);

    const salida = todoLoRegistrado();
    expect(salida).toContain('enl-1');
    expect(salida).toContain('env-1');
  });
});

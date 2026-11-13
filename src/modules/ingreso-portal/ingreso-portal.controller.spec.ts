import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HttpException,
  Logger,
  RequestMethod,
  UnauthorizedException,
} from '@nestjs/common';
import {
  INTERCEPTORS_METADATA,
  METHOD_METADATA,
  HTTP_CODE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CabecerasDeSeguridadInterceptor } from '../../common/publico/cabeceras-de-seguridad.interceptor';
import { IngresoPortalController } from './ingreso-portal.controller';
import {
  MENSAJE_CANJE_INVALIDO,
  MENSAJE_DEMASIADOS_INTENTOS,
  MENSAJE_SOLICITUD,
  PISO_CANJE_MS,
  PISO_SOLICITUD_MS,
} from './ingreso-portal.constantes';

const CORREO = 'ana@example.com';
const IP = '203.0.113.7';
const TOKEN = 'ab'.repeat(32);
const HASH = createHash('sha256').update(TOKEN).digest('hex');

type Resultado =
  | { resultado: 'sesion'; customToken: string }
  | { resultado: 'confirmado' }
  | null;

function montar(
  over: {
    solicitar?: () => Promise<void>;
    canjear?: () => Promise<Resultado>;
    permitir?: (clave: string) => boolean;
  } = {},
) {
  const llamadas: string[] = [];
  const limite = {
    permitir: jest.fn((clave: string) => {
      llamadas.push(clave);
      return Promise.resolve(over.permitir ? over.permitir(clave) : true);
    }),
  };
  const servicio = {
    solicitar: jest.fn(over.solicitar ?? (() => Promise.resolve())),
    canjear: jest.fn(over.canjear ?? (() => Promise.resolve(null))),
  };
  const controlador = new IngresoPortalController(
    servicio as never,
    limite as never,
  );
  return { controlador, servicio, limite, llamadas };
}

const req = { ip: IP };

/** Runs `fn` under fake timers and settles it at `ms`, reporting when it resolved. */
async function enTiempo<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<{ antes: boolean; despues: T | Error }> {
  let terminado = false;
  let valor: T | Error = new Error('pendiente');
  const promesa = fn().then(
    (v) => {
      terminado = true;
      valor = v;
    },
    (e: unknown) => {
      terminado = true;
      valor = e as Error;
    },
  );
  await jest.advanceTimersByTimeAsync(ms - 1);
  const antes = terminado;
  await jest.advanceTimersByTimeAsync(1);
  await promesa;
  return { antes, despues: valor };
}

describe('IngresoPortalController.solicitar', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is POST /auth/portal/solicitar, answers 202 and carries the security headers', () => {
    const proto = IngresoPortalController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(PATH_METADATA, IngresoPortalController)).toBe(
      'auth/portal',
    );
    expect(Reflect.getMetadata(PATH_METADATA, proto.solicitar)).toBe(
      'solicitar',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, proto.solicitar)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.solicitar)).toBe(202);
    expect(
      Reflect.getMetadata(INTERCEPTORS_METADATA, IngresoPortalController),
    ).toEqual([CabecerasDeSeguridadInterceptor]);
  });

  it('SEC: request answers are byte-identical (known, unknown, revoked, malformed, limited, mail off, failing)', async () => {
    const casos: Array<() => Promise<void>> = [
      () => Promise.resolve(), // known / unknown / revoked / limited / mail off: all silent
      () => Promise.reject(new Error('db down')), // a failure of the work
    ];
    const respuestas: string[] = [];
    for (const solicitar of casos) {
      for (const correo of [
        CORREO,
        'nadie@x.com',
        'no-es-correo',
        'a'.repeat(320),
      ]) {
        const m = montar({ solicitar });
        const { despues } = await enTiempo(
          () => m.controlador.solicitar({ correo }, req),
          PISO_SOLICITUD_MS,
        );
        respuestas.push(JSON.stringify(despues));
      }
    }

    expect(new Set(respuestas).size).toBe(1);
    expect(respuestas[0]).toBe(JSON.stringify({ mensaje: MENSAJE_SOLICITUD }));
    expect(MENSAJE_SOLICITUD).toBe(
      'Si tu correo está registrado, te enviamos un enlace para entrar.',
    );
  });

  it('SEC: the body never echoes the address', async () => {
    const m = montar();

    const { despues } = await enTiempo(
      () => m.controlador.solicitar({ correo: CORREO }, req),
      PISO_SOLICITUD_MS,
    );

    expect(JSON.stringify(despues).toLowerCase()).not.toContain('ana');
    expect(JSON.stringify(despues)).not.toContain('example');
  });

  it('SEC: request time is fixed (fast work waits for 1,500 ms, slow work does not extend it)', async () => {
    const rapida = montar({ solicitar: () => Promise.resolve() });
    const lenta = montar({
      solicitar: () => new Promise<void>((r) => setTimeout(r, 10_000)),
    });

    const a = await enTiempo(
      () => rapida.controlador.solicitar({ correo: CORREO }, req),
      PISO_SOLICITUD_MS,
    );
    const b = await enTiempo(
      () => lenta.controlador.solicitar({ correo: CORREO }, req),
      PISO_SOLICITUD_MS,
    );

    expect(PISO_SOLICITUD_MS).toBe(1500);
    expect(a.antes).toBe(false);
    expect(b.antes).toBe(false);
    expect(a.despues).toEqual({ mensaje: MENSAJE_SOLICITUD });
    expect(b.despues).toEqual({ mensaje: MENSAJE_SOLICITUD });
  });

  it('starts the work without waiting for it', async () => {
    const m = montar({
      solicitar: () => new Promise<void>((r) => setTimeout(r, 10_000)),
    });

    const promesa = m.controlador.solicitar({ correo: CORREO }, req);
    await jest.advanceTimersByTimeAsync(0);

    expect(m.servicio.solicitar).toHaveBeenCalledWith(CORREO, IP);
    await jest.advanceTimersByTimeAsync(PISO_SOLICITUD_MS);
    await expect(promesa).resolves.toEqual({ mensaje: MENSAJE_SOLICITUD });
  });

  it('SEC: rate limit fails closed (the 11th request per IP is a 429 before any lookup)', async () => {
    let n = 0;
    const m = montar({ permitir: () => ++n <= 10 });

    for (let i = 0; i < 10; i += 1) {
      await enTiempo(
        () => m.controlador.solicitar({ correo: CORREO }, req),
        PISO_SOLICITUD_MS,
      );
    }
    const undecima = await m.controlador
      .solicitar({ correo: CORREO }, req)
      .catch((e: unknown) => e as HttpException);

    expect(undecima).toBeInstanceOf(HttpException);
    expect((undecima as HttpException).getStatus()).toBe(429);
    expect((undecima as HttpException).message).toBe(
      MENSAJE_DEMASIADOS_INTENTOS,
    );
    expect(m.servicio.solicitar).toHaveBeenCalledTimes(10);
    expect(m.llamadas[0]).toBe(`limite:ingreso-solicitar:ip:${IP}`);
    expect(m.limite.permitir).toHaveBeenCalledWith(
      `limite:ingreso-solicitar:ip:${IP}`,
      10,
      60_000,
    );
  });

  it('SEC: rate limit fails closed (Redis down at the IP step is a 429, nothing started)', async () => {
    // The limiter answers false when Redis does not.
    const m = montar({ permitir: () => false });

    const error = await m.controlador
      .solicitar({ correo: CORREO }, req)
      .catch((e: unknown) => e as HttpException);

    expect((error as HttpException).getStatus()).toBe(429);
    expect(m.servicio.solicitar).not.toHaveBeenCalled();
  });

  it('another IP is served under its own counter (no global bucket)', async () => {
    const m = montar({ permitir: (clave) => !clave.endsWith(':203.0.113.9') });

    const bloqueada = await m.controlador
      .solicitar({ correo: CORREO }, { ip: '203.0.113.9' })
      .catch((e: unknown) => e as HttpException);
    const libre = await enTiempo(
      () => m.controlador.solicitar({ correo: CORREO }, { ip: IP }),
      PISO_SOLICITUD_MS,
    );

    expect((bloqueada as HttpException).getStatus()).toBe(429);
    expect(libre.despues).toEqual({ mensaje: MENSAJE_SOLICITUD });
    expect(
      m.llamadas.every((k) => k.startsWith('limite:ingreso-solicitar:ip:')),
    ).toBe(true);
  });

  it('SEC: una /64 de IPv6 es UN contador en las dos rutas (rotar la parte baja no da cupo nuevo)', async () => {
    const m = montar();

    await enTiempo(
      () =>
        m.controlador.solicitar(
          { correo: CORREO },
          { ip: '2001:db8:1:2:aaaa::1' },
        ),
      PISO_SOLICITUD_MS,
    );
    await enTiempo(
      () =>
        m.controlador.solicitar(
          { correo: CORREO },
          { ip: '2001:db8:1:2:bbbb::9' },
        ),
      PISO_SOLICITUD_MS,
    );
    await enTiempo(
      () =>
        m.controlador
          .canjear({ token: 'malformado' }, { ip: '2001:db8:1:2::77' })
          .catch(() => undefined),
      PISO_CANJE_MS,
    );

    expect(m.llamadas).toEqual([
      'limite:ingreso-solicitar:ip:v6-20010db800010002',
      'limite:ingreso-solicitar:ip:v6-20010db800010002',
      'limite:ingreso-canjear:ip:v6-20010db800010002',
    ]);
    // IPv4 keys are unchanged.
    expect(m.servicio.solicitar).toHaveBeenCalledTimes(2);
  });
});

describe('IngresoPortalController.canjear', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is POST /auth/portal/canjear, answers 200 and carries the security headers', () => {
    const proto = IngresoPortalController.prototype as unknown as Record<
      string,
      object
    >;
    expect(Reflect.getMetadata(PATH_METADATA, proto.canjear)).toBe('canjear');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.canjear)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.canjear)).toBe(200);
  });

  it('SEC: redeem refusals are byte-identical and never before 300 ms', async () => {
    const casos: Array<{ token: string; canjear: () => Promise<Resultado> }> = [
      { token: TOKEN, canjear: () => Promise.resolve(null) }, // unknown/expired/used/ineligible/inactive
      { token: TOKEN, canjear: () => Promise.reject(new Error('boom')) }, // thrown
      { token: 'hola', canjear: () => Promise.resolve(null) }, // malformed
      { token: 'A'.repeat(64), canjear: () => Promise.resolve(null) }, // not lowercase hex
      { token: 'a'.repeat(128), canjear: () => Promise.resolve(null) }, // long
    ];
    const respuestas: string[] = [];
    for (const caso of casos) {
      const m = montar({ canjear: caso.canjear });
      const { antes, despues } = await enTiempo(
        () => m.controlador.canjear({ token: caso.token }, req),
        PISO_CANJE_MS,
      );
      expect(antes).toBe(false);
      expect(despues).toBeInstanceOf(UnauthorizedException);
      respuestas.push(
        JSON.stringify((despues as UnauthorizedException).getResponse()),
      );
    }

    expect(PISO_CANJE_MS).toBe(300);
    expect(new Set(respuestas).size).toBe(1);
    expect(respuestas[0]).toContain(MENSAJE_CANJE_INVALIDO);
    expect(MENSAJE_CANJE_INVALIDO).toBe('El enlace no es válido o venció');
  });

  it('a malformed token never reaches the service nor creates a per-token key', async () => {
    const m = montar();

    await enTiempo(
      () => m.controlador.canjear({ token: 'hola' }, req),
      PISO_CANJE_MS,
    );

    expect(m.servicio.canjear).not.toHaveBeenCalled();
    expect(m.llamadas).toEqual([`limite:ingreso-canjear:ip:${IP}`]);
  });

  it('SEC: token replay is refused (the second redeem of a spent token is a 401)', async () => {
    const respuestas: Resultado[] = [
      { resultado: 'sesion', customToken: 'ct' },
      null,
    ];
    const m = montar({ canjear: () => Promise.resolve(respuestas.shift()!) });

    const primero = await m.controlador.canjear({ token: TOKEN }, req);
    const segundo = await enTiempo(
      () => m.controlador.canjear({ token: TOKEN }, req),
      PISO_CANJE_MS,
    );

    expect(primero).toEqual({ resultado: 'sesion', customToken: 'ct' });
    expect(segundo.despues).toBeInstanceOf(UnauthorizedException);
  });

  it('a success carries only resultado / customToken, or resultado alone', async () => {
    const sesion = montar({
      canjear: () =>
        Promise.resolve({ resultado: 'sesion', customToken: 'ct-1' }),
    });
    const confirmado = montar({
      canjear: () => Promise.resolve({ resultado: 'confirmado' }),
    });

    const a = await sesion.controlador.canjear({ token: TOKEN }, req);
    const b = await confirmado.controlador.canjear({ token: TOKEN }, req);

    expect(Object.keys(a).sort()).toEqual(['customToken', 'resultado']);
    expect(b).toEqual({ resultado: 'confirmado' });
    expect(JSON.stringify(b)).not.toContain('oken');
  });

  it('SEC: rate limit fails closed (21st per IP and 6th per token are 429; keys hold a hash, never the token)', async () => {
    const porIp = montar({
      permitir: (k) => !k.startsWith('limite:ingreso-canjear:ip:'),
    });
    const porToken = montar({
      permitir: (k) => !k.startsWith('limite:ingreso-canjear:token:'),
    });

    const a = await porIp.controlador
      .canjear({ token: TOKEN }, req)
      .catch((e: unknown) => e as HttpException);
    const b = await porToken.controlador
      .canjear({ token: TOKEN }, req)
      .catch((e: unknown) => e as HttpException);

    expect((a as HttpException).getStatus()).toBe(429);
    expect((b as HttpException).getStatus()).toBe(429);
    expect(porIp.servicio.canjear).not.toHaveBeenCalled();
    expect(porToken.servicio.canjear).not.toHaveBeenCalled();
    expect(porToken.limite.permitir).toHaveBeenCalledWith(
      `limite:ingreso-canjear:ip:${IP}`,
      20,
      60_000,
    );
    expect(porToken.limite.permitir).toHaveBeenCalledWith(
      `limite:ingreso-canjear:token:${HASH}`,
      5,
      60_000,
    );
    for (const clave of porToken.llamadas) {
      expect(clave).not.toContain(TOKEN);
    }
  });

  it('SEC: rate limit fails closed (Redis down answers 429, never a session)', async () => {
    const m = montar({
      permitir: () => false,
      canjear: () =>
        Promise.resolve({ resultado: 'sesion', customToken: 'ct' }),
    });

    const error = await m.controlador
      .canjear({ token: TOKEN }, req)
      .catch((e: unknown) => e as HttpException);

    expect((error as HttpException).getStatus()).toBe(429);
    expect(m.servicio.canjear).not.toHaveBeenCalled();
  });
});

describe('the public routes read no token over GET and log nothing', () => {
  it('every route of the controller is a POST', () => {
    const proto = IngresoPortalController.prototype as unknown as Record<
      string,
      object
    >;
    const rutas = Object.getOwnPropertyNames(proto).filter(
      (n) =>
        n !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[n]),
    );
    expect(rutas.sort()).toEqual(['canjear', 'solicitar']);
    for (const nombre of rutas) {
      expect(Reflect.getMetadata(METHOD_METADATA, proto[nombre])).toBe(
        RequestMethod.POST,
      );
    }
  });

  it('no controller reads a token from a query string or a path', () => {
    const raiz = join(__dirname, '..');
    const controladores = (
      readdirSync(raiz, { recursive: true }) as string[]
    ).filter((f) => f.endsWith('.controller.ts'));
    expect(controladores.length).toBeGreaterThan(10);
    for (const f of controladores) {
      const fuente = readFileSync(join(raiz, f), 'utf8');
      expect(fuente).not.toMatch(/@Query\(\s*['"]token['"]/);
      expect(fuente).not.toMatch(/@Get\([^)]*:token/);
    }
  });

  const NIVELES = ['log', 'debug', 'warn', 'error', 'verbose'] as const;
  const espias = NIVELES.map((nivel) =>
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined),
  );
  afterAll(() => espias.forEach((e) => e.mockRestore()));

  it('SEC: a Logger spy across all paths never receives an address, token, hash, IP or body', async () => {
    jest.useFakeTimers();
    try {
      const casos = [
        montar(),
        montar({ solicitar: () => Promise.reject(new Error('db down')) }),
        montar({ permitir: () => false }),
        montar({ canjear: () => Promise.reject(new Error('boom')) }),
        montar({
          canjear: () =>
            Promise.resolve({ resultado: 'sesion', customToken: 'ct-secreto' }),
        }),
      ];
      for (const m of casos) {
        await enTiempo(
          () => m.controlador.solicitar({ correo: CORREO }, req).catch(() => 0),
          PISO_SOLICITUD_MS,
        );
        await enTiempo(
          () => m.controlador.canjear({ token: TOKEN }, req).catch(() => 0),
          PISO_CANJE_MS,
        );
      }
    } finally {
      jest.useRealTimers();
    }

    const salida = espias
      .flatMap((e) => e.mock.calls as unknown[][])
      .map((llamada) => llamada.map(String).join(' '))
      .join(' | ')
      .toLowerCase();
    for (const secreto of [CORREO, TOKEN, HASH, IP, 'ct-secreto', 'ana']) {
      expect(salida).not.toContain(secreto);
    }
  });
});

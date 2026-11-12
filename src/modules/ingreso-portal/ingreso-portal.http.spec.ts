import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import request from 'supertest';
import { configureApp } from '../../app-setup';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import { FiltroExcepcionesSentry } from '../../common/sentry/filtro-sentry';
import {
  MENSAJE_CANJE_INVALIDO,
  MENSAJE_DEMASIADOS_INTENTOS,
  MENSAJE_SOLICITUD,
  PISO_CANJE_MS,
  PISO_SOLICITUD_MS,
} from './ingreso-portal.constantes';
import { IngresoPortalController } from './ingreso-portal.controller';
import { IngresoPortalService } from './ingreso-portal.service';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

const SOLICITAR = '/api/v1/auth/portal/solicitar';
const CANJEAR = '/api/v1/auth/portal/canjear';
const TOKEN = 'ab12'.repeat(16);

const CABECERAS_DE_SEGURIDAD = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

const estado: {
  permitir: boolean;
  solicitar: () => Promise<void>;
  canjear: () => Promise<unknown>;
} = {
  permitir: true,
  solicitar: () => Promise.resolve(),
  canjear: () => Promise.resolve(null),
};

const servicio = {
  solicitar: jest.fn(() => estado.solicitar()),
  canjear: jest.fn(() => estado.canjear()),
};
const limite = { permitir: jest.fn(() => Promise.resolve(estado.permitir)) };

@Module({
  controllers: [IngresoPortalController],
  providers: [
    { provide: IngresoPortalService, useValue: servicio },
    { provide: LimiteIntentosService, useValue: limite },
    // The same global filter `app.module.ts` registers.
    { provide: APP_FILTER, useClass: FiltroExcepcionesSentry },
  ],
})
class ProbeModule {}

function esperarCabecerasDeSeguridad(res: request.Response): void {
  for (const [nombre, valor] of Object.entries(CABECERAS_DE_SEGURIDAD)) {
    expect(res.headers[nombre]).toBe(valor);
  }
}

/** Status, body and headers as the wire carries them, minus the clock. */
function huella(res: request.Response): string {
  const { date: _fecha, ...cabeceras } = res.headers;
  void _fecha;
  return JSON.stringify([res.status, res.text, cabeceras]);
}

/**
 * The two public routes on a real Nest/Express app with the project's global
 * configuration (prefix, ValidationPipe, envelope interceptor) and the Sentry
 * filter, and NO database: the service and the limiter are stubs. Proves what
 * a controller unit test cannot: the real wire answers are identical, and the
 * security headers ride on the 400, the 401 and the 429 too.
 */
describe('POST /auth/portal/* sobre una app HTTP real', () => {
  let app: INestApplication;
  const servidor = () => app.getHttpServer() as import('node:http').Server;
  const capturar = Sentry.captureException as jest.Mock;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    configureApp(app, { env: 'development', corsOrigins: '' });
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    capturar.mockClear();
    servicio.solicitar.mockClear();
    servicio.canjear.mockClear();
    limite.permitir.mockClear();
    estado.permitir = true;
    estado.solicitar = () => Promise.resolve();
    estado.canjear = () => Promise.resolve(null);
  });

  it('SEC: request answers are byte-identical on the wire and leave at the fixed time', async () => {
    const inicio = Date.now();
    const respuestas = await Promise.all([
      request(servidor()).post(SOLICITAR).send({ correo: 'ana@example.com' }),
      request(servidor()).post(SOLICITAR).send({ correo: 'nadie@example.com' }),
      request(servidor()).post(SOLICITAR).send({ correo: 'no-es-correo' }),
    ]);
    // A failing work behaves the same.
    estado.solicitar = () => Promise.reject(new Error('db down'));
    respuestas.push(
      await request(servidor())
        .post(SOLICITAR)
        .send({ correo: 'ana@example.com' }),
    );
    const total = Date.now() - inicio;

    for (const res of respuestas) {
      expect(res.status).toBe(202);
      expect(res.body).toEqual({
        statusCode: 202,
        data: { mensaje: MENSAJE_SOLICITUD },
      });
      esperarCabecerasDeSeguridad(res);
      expect(res.text).not.toContain('example');
    }
    expect(new Set(respuestas.map(huella)).size).toBe(1);
    expect(total).toBeGreaterThanOrEqual(PISO_SOLICITUD_MS - 10);
    expect(servicio.solicitar).toHaveBeenCalledTimes(4);
    expect(capturar).not.toHaveBeenCalled();
  });

  it('SEC: redeem refusals are byte-identical on the wire and never before the floor', async () => {
    const intentos: Array<[string, () => Promise<unknown>]> = [
      [TOKEN, () => Promise.resolve(null)],
      ['hola', () => Promise.resolve(null)],
      [TOKEN, () => Promise.reject(new Error('boom'))],
    ];
    const respuestas: request.Response[] = [];
    for (const [token, canjear] of intentos) {
      estado.canjear = canjear;
      const inicio = Date.now();
      const res = await request(servidor()).post(CANJEAR).send({ token });
      expect(Date.now() - inicio).toBeGreaterThanOrEqual(PISO_CANJE_MS - 5);
      respuestas.push(res);
    }

    for (const res of respuestas) {
      expect(res.status).toBe(401);
      expect((res.body as { message: string }).message).toBe(
        MENSAJE_CANJE_INVALIDO,
      );
      esperarCabecerasDeSeguridad(res);
    }
    expect(new Set(respuestas.map(huella)).size).toBe(1);
    expect(capturar).not.toHaveBeenCalled();
  });

  it('a successful redeem answers inside the envelope with nothing else', async () => {
    estado.canjear = () =>
      Promise.resolve({ resultado: 'sesion', customToken: 'ct-1' });

    const res = await request(servidor()).post(CANJEAR).send({ token: TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      statusCode: 200,
      data: { resultado: 'sesion', customToken: 'ct-1' },
    });
    esperarCabecerasDeSeguridad(res);
  });

  it('the 429 of both routes carries the security headers and the existing sentence', async () => {
    estado.permitir = false;

    const a = await request(servidor())
      .post(SOLICITAR)
      .send({ correo: 'ana@example.com' });
    const b = await request(servidor()).post(CANJEAR).send({ token: TOKEN });

    for (const res of [a, b]) {
      expect(res.status).toBe(429);
      expect((res.body as { message: string }).message).toBe(
        MENSAJE_DEMASIADOS_INTENTOS,
      );
      esperarCabecerasDeSeguridad(res);
    }
    expect(servicio.solicitar).not.toHaveBeenCalled();
    expect(servicio.canjear).not.toHaveBeenCalled();
  });

  it.each([
    [SOLICITAR, 'sin correo', {}],
    [SOLICITAR, 'correo no textual', { correo: 5 }],
    [SOLICITAR, 'correo de 321 caracteres', { correo: 'a'.repeat(321) }],
    [SOLICITAR, 'campo extra', { correo: 'a@x.com', otro: 1 }],
    [CANJEAR, 'sin token', {}],
    [CANJEAR, 'token no textual', { token: {} }],
    [CANJEAR, 'token de 300 caracteres', { token: 'a'.repeat(300) }],
    [CANJEAR, 'campo extra', { token: TOKEN, otro: 1 }],
  ])(
    'el 400 por la forma del cuerpo (%s, %s) también lleva las cabeceras de seguridad',
    async (ruta, _nombre, cuerpo) => {
      const res = await request(servidor()).post(ruta).send(cuerpo);

      expect(res.status).toBe(400);
      esperarCabecerasDeSeguridad(res);
      expect(servicio.solicitar).not.toHaveBeenCalled();
      expect(servicio.canjear).not.toHaveBeenCalled();
      expect(limite.permitir).not.toHaveBeenCalled();
    },
  );

  it('no GET answers on either path (nothing is consumed by opening the page)', async () => {
    const a = await request(servidor()).get(SOLICITAR);
    const b = await request(servidor()).get(`${CANJEAR}?token=${TOKEN}`);

    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(servicio.canjear).not.toHaveBeenCalled();
  });
});

import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import * as Sentry from '@sentry/node';
import { configureApp } from '../../app-setup';
import { LimiteIntentosService } from '../../common/redis/limite-intentos.service';
import { FiltroExcepcionesSentry } from '../../common/sentry/filtro-sentry';
import { EnlaceFacturaService } from './enlace-factura.service';
import { FacturaPublicaController } from './factura-publica.controller';
import { MENSAJE_OPACO, PISO_DE_TIEMPO_MS } from './factura-publica.constantes';

jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

const RUTA = '/api/v1/publico/facturas/pdf';
const TOKEN = 'ab12'.repeat(16);

const CABECERAS_DE_SEGURIDAD = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

const estado: {
  resolucion: unknown;
  permitir: boolean;
} = { resolucion: null, permitir: true };

const enlaces = {
  resolver: jest.fn(() => Promise.resolve(estado.resolucion)),
};
const limite = {
  permitir: jest.fn(() => Promise.resolve(estado.permitir)),
};

@Module({
  controllers: [FacturaPublicaController],
  providers: [
    { provide: EnlaceFacturaService, useValue: enlaces },
    { provide: LimiteIntentosService, useValue: limite },
    // The same global filter `app.module.ts` registers.
    { provide: APP_FILTER, useClass: FiltroExcepcionesSentry },
  ],
})
class ProbeModule {}

async function pdfValido(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  return pdf.save();
}

function esperarCabecerasDeSeguridad(res: request.Response): void {
  for (const [nombre, valor] of Object.entries(CABECERAS_DE_SEGURIDAD)) {
    expect(res.headers[nombre]).toBe(valor);
  }
}

/**
 * The public PDF route on a real Nest/Express app with the project's global
 * configuration (`configureApp`: prefix, ValidationPipe, envelope interceptor)
 * and the Sentry exception filter, and NO database: the link service and the
 * limiter are stubs. Proves what a unit test of the controller cannot: that the
 * bytes leave untouched by the envelope and nothing is reported after sending.
 */
describe('POST /publico/facturas/pdf sobre una app HTTP real', () => {
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
    enlaces.resolver.mockClear();
    estado.permitir = true;
    estado.resolucion = null;
  });

  /** Lets any error raised after the response finished reach the filter. */
  const asentar = () => new Promise((r) => setTimeout(r, 50));

  it('sirve el PDF tal cual (sin sobre), con sus cabeceras, y no reporta ninguna excepción', async () => {
    const bytes = await pdfValido();
    estado.resolucion = {
      bytes,
      numeroCompleto: 'FV-0001',
      enlaceId: 'enl-1',
      envioFacturaId: 'env-1',
    };

    const res = await request(servidor())
      .post(RUTA)
      .send({ token: TOKEN })
      .buffer(true)
      .parse((r, cb) => {
        const partes: Buffer[] = [];
        r.on('data', (c: Buffer) => partes.push(c));
        r.on('end', () => cb(null, Buffer.concat(partes)));
      });
    await asentar();

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['content-disposition']).toBe(
      'inline; filename="factura-FV-0001.pdf"',
    );
    esperarCabecerasDeSeguridad(res);
    expect(Buffer.compare(res.body as Buffer, Buffer.from(bytes))).toBe(0);
    expect(capturar).not.toHaveBeenCalled();
  });

  it('el 404 opaco lleva las cabeceras de seguridad y no responde antes del piso', async () => {
    const inicio = Date.now();
    const res = await request(servidor()).post(RUTA).send({ token: TOKEN });

    expect(Date.now() - inicio).toBeGreaterThanOrEqual(PISO_DE_TIEMPO_MS - 5);
    expect(res.status).toBe(404);
    expect((res.body as { message: string }).message).toBe(MENSAJE_OPACO);
    esperarCabecerasDeSeguridad(res);
    expect(capturar).not.toHaveBeenCalled();
  });

  it('el 429 lleva las cabeceras de seguridad', async () => {
    estado.permitir = false;

    const res = await request(servidor()).post(RUTA).send({ token: TOKEN });

    expect(res.status).toBe(429);
    esperarCabecerasDeSeguridad(res);
  });
});

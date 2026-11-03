import { Controller, Get, Module, UseGuards } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { configureApp } from '../../app-setup';
import { hmacSha256Hex } from '../../common/utils/hmac';
import { cadenaFirma } from './firma-panel';
import { FirmaPanelGuard } from './firma-panel.guard';
import { PanelHabilitadoGuard } from './panel-habilitado.guard';

const SECRET = 'panel-http-secret-0123456789abcdef-xyz';
const RUTA = '/api/v1/integraciones/panel/registros';

const lectura = jest.fn();
const estado: { secreto: string | undefined; habilitado: boolean } = {
  secreto: SECRET,
  habilitado: true,
};

@Controller('integraciones/panel')
@UseGuards(FirmaPanelGuard, PanelHabilitadoGuard)
class ProbeController {
  @Get('registros')
  listar() {
    lectura();
    return { items: [], total: 0 };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [
    {
      provide: ConfigService,
      useValue: {
        get: (clave: string) => {
          if (clave === 'app.panelHmacSecret') return estado.secreto;
          if (clave === 'app.integracionPanelHabilitada')
            return estado.habilitado;
          return undefined;
        },
      },
    },
  ],
})
class ProbeModule {}

const cabeceras = (ruta: string, secret = SECRET) => {
  const ts = String(Math.floor(Date.now() / 1000));
  const firma = hmacSha256Hex(
    secret,
    cadenaFirma({ timestamp: ts, metodo: 'GET', ruta, rawBody: '' }),
  );
  return {
    'X-Websaco-Timestamp': ts,
    'X-Websaco-Signature': `sha256=${firma}`,
  };
};

/**
 * Runs both guards on a real Nest/Express app with the project's global
 * configuration and NO database. `rawBody: true` mirrors `main.ts`: without it
 * the guard could not sign request bodies.
 */
describe('Módulo del panel sobre una app HTTP real', () => {
  let app: INestApplication;
  const servidor = () => app.getHttpServer() as import('node:http').Server;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, {
      logger: false,
      rawBody: true,
    });
    configureApp(app, { env: 'development', corsOrigins: '' });
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    estado.secreto = SECRET;
    estado.habilitado = true;
    lectura.mockClear();
  });

  it('firma válida y módulo encendido: 200 dentro del sobre', async () => {
    const res = await request(servidor()).get(RUTA).set(cabeceras(RUTA));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      statusCode: 200,
      data: { items: [], total: 0 },
    });
  });

  it('firma válida y módulo apagado: 503 PANEL_APAGADO y sin lectura', async () => {
    estado.habilitado = false;

    const res = await request(servidor()).get(RUTA).set(cabeceras(RUTA));

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'PANEL_APAGADO' });
    expect(lectura).not.toHaveBeenCalled();
  });

  it('sin firma y módulo apagado: 401, no revela el interruptor', async () => {
    estado.habilitado = false;

    const res = await request(servidor()).get(RUTA);

    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('code');
    expect(lectura).not.toHaveBeenCalled();
  });

  it('firma incorrecta y módulo apagado: 401', async () => {
    estado.habilitado = false;

    await request(servidor())
      .get(RUTA)
      .set(cabeceras(RUTA, 'otro-secreto-de-al-menos-32-caracteres'))
      .expect(401);
  });

  it('sin secreto configurado: 401 aunque la firma sea correcta', async () => {
    estado.secreto = undefined;

    await request(servidor()).get(RUTA).set(cabeceras(RUTA)).expect(401);
    expect(lectura).not.toHaveBeenCalled();
  });
});

import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { configureApp } from '../../app-setup';
import { hmacSha256Hex } from '../../common/utils/hmac';
import { cadenaFirma } from './firma-panel';
import { FirmaPanelGuard } from './firma-panel.guard';
import { IntegracionesPanelController } from './integraciones-panel.controller';
import { IntegracionesPanelService } from './integraciones-panel.service';
import { PanelHabilitadoGuard } from './panel-habilitado.guard';

const SECRET = 'panel-rutas-secret-0123456789abcdef-xyz';
const BASE = '/api/v1/integraciones/panel/registros';
const ID = '670000000000000000000001';
const A = 'a'.repeat(24);

const servicio = {
  listar: jest.fn(),
  fijarVinculo: jest.fn(),
};

@Module({
  controllers: [IntegracionesPanelController],
  providers: [
    FirmaPanelGuard,
    PanelHabilitadoGuard,
    { provide: IntegracionesPanelService, useValue: servicio },
    {
      provide: ConfigService,
      useValue: {
        get: (clave: string) => {
          if (clave === 'app.panelHmacSecret') return SECRET;
          if (clave === 'app.integracionPanelHabilitada') return true;
          return undefined;
        },
      },
    },
  ],
})
class PruebaModule {}

const firmar = (metodo: string, ruta: string, cuerpo = '') => {
  const ts = String(Math.floor(Date.now() / 1000));
  const firma = hmacSha256Hex(
    SECRET,
    cadenaFirma({ timestamp: ts, metodo, ruta, rawBody: cuerpo }),
  );
  return {
    'X-Websaco-Timestamp': ts,
    'X-Websaco-Signature': `sha256=${firma}`,
  };
};

/** Real app (prefix, global ValidationPipe, envelope), fake service. */
describe('Rutas del panel sobre una app HTTP real', () => {
  let app: INestApplication;
  const servidor = () => app.getHttpServer() as import('node:http').Server;

  const get = (consulta = '') =>
    request(servidor())
      .get(`${BASE}${consulta}`)
      .set(firmar('GET', `${BASE}${consulta}`));

  const put = (cuerpo: unknown, id = ID) => {
    const ruta = `${BASE}/${id}/vinculo`;
    const texto = JSON.stringify(cuerpo);
    return request(servidor())
      .put(ruta)
      .set(firmar('PUT', ruta, texto))
      .set('Content-Type', 'application/json')
      .send(texto);
  };

  beforeAll(async () => {
    app = await NestFactory.create(PruebaModule, {
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
    servicio.listar.mockReset().mockResolvedValue({ items: [], total: 0 });
    servicio.fijarVinculo
      .mockReset()
      .mockResolvedValue({ sistema: 'comptable', registroId: A });
  });

  describe('GET registros', () => {
    it('responde dentro del sobre { statusCode, data }', async () => {
      const res = await get('?q=pinos&pagina=2&limite=10').expect(200);

      expect(res.body).toEqual({
        statusCode: 200,
        data: { items: [], total: 0 },
      });
      expect(servicio.listar).toHaveBeenCalledWith({
        q: 'pinos',
        pagina: 2,
        limite: 10,
      });
    });

    it('límite 100: pasa; 101: 400', async () => {
      await get('?limite=100').expect(200);
      await get('?limite=101').expect(400);
    });

    it('página 0 o no numérica: 400', async () => {
      await get('?pagina=0').expect(400);
      await get('?pagina=abc').expect(400);
    });

    it('una página absurda que desbordaría el skip: 400, no 500', async () => {
      await get('?pagina=100001').expect(400);
      expect(servicio.listar).not.toHaveBeenCalled();
    });

    it('un byte NUL en q: 400, no un 500 de Mongo', async () => {
      await get('?q=a%00b').expect(400);
      expect(servicio.listar).not.toHaveBeenCalled();
    });

    it('un parámetro no declarado: 400', async () => {
      await get('?otro=1').expect(400);
      expect(servicio.listar).not.toHaveBeenCalled();
    });

    it('id que no es un ObjectId de 24 hex: 400; con 24 hex: pasa', async () => {
      await get('?id=no-es-un-id').expect(400);
      await get(`?id=0x${'a'.repeat(22)}`).expect(400);
      await get(`?id=${ID}`).expect(200);
    });
  });

  describe('PUT registros/:id/vinculo', () => {
    it('un cuerpo válido llega al servicio con el id de la ruta', async () => {
      const res = await put({ sistema: 'comptable', registroId: A }).expect(
        200,
      );

      expect(res.body).toEqual({
        statusCode: 200,
        data: { sistema: 'comptable', registroId: A },
      });
      expect(servicio.fijarVinculo).toHaveBeenCalledWith(
        ID,
        expect.objectContaining({ sistema: 'comptable', registroId: A }),
      );
    });

    it('acepta registroId null con esperado, y forzar', async () => {
      await put({
        sistema: 'comptable',
        registroId: null,
        esperado: A,
      }).expect(200);
      await put({ sistema: 'comptable', registroId: A, forzar: true }).expect(
        200,
      );
    });

    it('un campo no declarado: 400', async () => {
      await put({ sistema: 'comptable', registroId: A, otro: 1 }).expect(400);
      expect(servicio.fijarVinculo).not.toHaveBeenCalled();
    });

    it('sin sistema o sin registroId: 400', async () => {
      await put({ registroId: A }).expect(400);
      await put({ sistema: 'comptable' }).expect(400);
    });

    it('registroId con formato inválido: 400', async () => {
      await put({ sistema: 'comptable', registroId: 'corto' }).expect(400);
      await put({
        sistema: 'comptable',
        registroId: `0x${'a'.repeat(22)}`,
      }).expect(400);
    });

    it('un sistema de más de 50 caracteres: 400 (no se refleja entero en el 422)', async () => {
      await put({ sistema: 'x'.repeat(51), registroId: A }).expect(400);
      expect(servicio.fijarVinculo).not.toHaveBeenCalled();
    });

    it('un id de ruta que no es ObjectId: 400', async () => {
      await put({ sistema: 'comptable', registroId: A }, 'no-es-un-id').expect(
        400,
      );
      expect(servicio.fijarVinculo).not.toHaveBeenCalled();
    });

    it('un sistema que el servicio no soporta llega al servicio (él responde 422)', async () => {
      await put({ sistema: 'nomina', registroId: A }).expect(200);

      expect(servicio.fijarVinculo).toHaveBeenCalledWith(
        ID,
        expect.objectContaining({ sistema: 'nomina' }),
      );
    });

    it('un cuerpo alterado después de firmar: 401 y sin escritura', async () => {
      const ruta = `${BASE}/${ID}/vinculo`;
      const firmado = JSON.stringify({ sistema: 'comptable', registroId: A });

      await request(servidor())
        .put(ruta)
        .set(firmar('PUT', ruta, firmado))
        .set('Content-Type', 'application/json')
        .send(
          JSON.stringify({ sistema: 'comptable', registroId: 'b'.repeat(24) }),
        )
        .expect(401);

      expect(servicio.fijarVinculo).not.toHaveBeenCalled();
    });
  });
});

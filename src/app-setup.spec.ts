import {
  Body,
  Controller,
  Get,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IsString } from 'class-validator';
import type { Server } from 'node:http';
import request from 'supertest';
import { configureApp } from './app-setup';

class CrearCosaDto {
  @IsString()
  nombre!: string;
}

@Controller('cosas')
class ProbeController {
  @Get()
  listar() {
    return [{ id: '1' }];
  }

  @Get('uno')
  uno() {
    return { id: '1', nombre: 'algo' };
  }

  @Post()
  crear(@Body() dto: CrearCosaDto) {
    return { recibido: dto.nombre };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/**
 * Contract test for the wire format.
 *
 * The unit tests for the interceptor and the CORS policy prove those pieces
 * behave. This one proves they are actually TURNED ON — the failure that
 * shipped twice, invisible to every green suite on both sides, because "the
 * class works" and "the app uses it" are different claims.
 *
 * Anything the browser client depends on being globally applied belongs here.
 */
describe('configureApp (contrato de la API)', () => {
  let app: INestApplication;
  const server = (): Server => app.getHttpServer() as Server;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    configureApp(app, { env: 'development', corsOrigins: '' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('prefijo global', () => {
    it('sirve bajo /api/v1', async () => {
      await request(server()).get('/api/v1/cosas').expect(200);
    });

    it('no responde sin el prefijo', async () => {
      // Es el error de configuración más fácil del lado del cliente: un
      // VITE_API_URL sin /api/v1 hace que TODO responda 404.
      await request(server()).get('/cosas').expect(404);
    });
  });

  describe('sobre de respuesta', () => {
    it('envuelve un objeto en { statusCode, data }', async () => {
      const res = await request(server()).get('/api/v1/cosas/uno').expect(200);

      expect(res.body).toEqual({
        statusCode: 200,
        data: { id: '1', nombre: 'algo' },
      });
    });

    it('envuelve un listado sin aplanarlo', async () => {
      const res = await request(server()).get('/api/v1/cosas').expect(200);

      expect(res.body).toEqual({ statusCode: 200, data: [{ id: '1' }] });
    });

    it('reporta 201 en un POST, no 200', async () => {
      const res = await request(server())
        .post('/api/v1/cosas')
        .send({ nombre: 'x' })
        .expect(201);

      expect(res.body).toEqual({ statusCode: 201, data: { recibido: 'x' } });
    });

    it('un error NO viene envuelto: conserva la forma de Nest', async () => {
      // El cliente lee el texto del error de `message`. Si esto cambiara, los
      // mensajes de error de la app se quedarían mudos.
      const res = await request(server())
        .post('/api/v1/cosas')
        .send({ nombre: 123 })
        .expect(400);

      expect(res.body).toHaveProperty('message');
      expect(res.body).not.toHaveProperty('data');
    });
  });

  describe('validación de entrada', () => {
    it('rechaza un campo que el DTO no declara', async () => {
      const res = await request(server())
        .post('/api/v1/cosas')
        .send({ nombre: 'x', colado: 'no deberia entrar' })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('colado');
    });
  });

  describe('CORS', () => {
    it('autoriza un origen de localhost en desarrollo', async () => {
      const res = await request(server())
        .get('/api/v1/cosas')
        .set('Origin', 'http://localhost:5173')
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
    });

    it('deja pasar el preflight con la cabecera Authorization', async () => {
      // Sin esto el navegador bloquea toda llamada autenticada y axios lo
      // reporta como un "Network Error" que parece un servidor caído.
      const res = await request(server())
        .options('/api/v1/cosas')
        .set('Origin', 'http://localhost:5173')
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization');

      expect(res.status).toBeLessThan(400);
      expect(
        (res.headers['access-control-allow-headers'] ?? '').toLowerCase(),
      ).toContain('authorization');
    });

    it('no autoriza un origen externo', async () => {
      const res = await request(server())
        .get('/api/v1/cosas')
        .set('Origin', 'https://sitio-ajeno.com');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});

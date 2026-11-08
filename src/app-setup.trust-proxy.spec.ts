import { Controller, Get, Module, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { configureApp } from './app-setup';

@Controller('ip')
class IpController {
  @Get()
  ip(@Req() req: { ip?: string }) {
    return { ip: req.ip };
  }
}

@Module({ controllers: [IpController] })
class IpModule {}

const montar = async (trustProxyHops: number): Promise<INestApplication> => {
  const app = await NestFactory.create(IpModule, { logger: false });
  configureApp(app, { env: 'development', corsOrigins: '', trustProxyHops });
  await app.init();
  return app;
};

/**
 * `req.ip` keys the per-address limit of the public access-link redeem. Behind
 * Cloud Run the socket peer is Google's front end, which APPENDS the real
 * client address to X-Forwarded-For; whatever the client wrote there comes
 * first and must never be believed.
 */
describe('configureApp — trust proxy por número de saltos', () => {
  it('con 1 salto toma la dirección que agregó el proxy, no la que el cliente inventó', async () => {
    const app = await montar(1);
    try {
      const res = await request(app.getHttpServer() as Server)
        .get('/api/v1/ip')
        // A spoofed entry first, then what the front end appended.
        .set('X-Forwarded-For', '6.6.6.6, 203.0.113.7')
        .expect(200);
      expect((res.body as { data: { ip: string } }).data.ip).toBe(
        '203.0.113.7',
      );
    } finally {
      await app.close();
    }
  });

  it('un X-Forwarded-For distinto en cada solicitud no cambia la dirección vista si el proxy agrega la misma', async () => {
    const app = await montar(1);
    try {
      const ips = await Promise.all(
        ['1.1.1.1', '2.2.2.2'].map(async (falsa) => {
          const res = await request(app.getHttpServer() as Server)
            .get('/api/v1/ip')
            .set('X-Forwarded-For', `${falsa}, 203.0.113.7`);
          return (res.body as { data: { ip: string } }).data.ip;
        }),
      );
      expect(ips).toEqual(['203.0.113.7', '203.0.113.7']);
    } finally {
      await app.close();
    }
  });

  it('con 0 saltos ignora X-Forwarded-For por completo (dirección del socket)', async () => {
    const app = await montar(0);
    try {
      const res = await request(app.getHttpServer() as Server)
        .get('/api/v1/ip')
        .set('X-Forwarded-For', '6.6.6.6')
        .expect(200);
      expect((res.body as { data: { ip: string } }).data.ip).not.toBe(
        '6.6.6.6',
      );
    } finally {
      await app.close();
    }
  });
});

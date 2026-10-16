import { Controller, Get, Module, Query, UseGuards } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { IsString, Matches } from 'class-validator';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { configureApp } from '../../app-setup';
import { hmacSha256Hex } from '../../common/utils/hmac';
import { FirmaWebsaco3Guard } from './firma-websaco3.guard';
import { cadenaFirmaPropietarios, rutaYConsulta } from './propietarios.firma';

const SECRET = 'propietarios-http-secret-0123456789abcdef';
const RUTA = '/api/v1/integraciones/websaco3/propietarios';
const ID = '507f1f77bcf86cd799439011';

/** Stand-in for the PR 2b DTO: strict 24-hex id, no extras (global pipe). */
class ConsultaProbeDto {
  @IsString()
  @Matches(/^[0-9a-fA-F]{24}$/)
  websaco3CopropiedadId!: string;
}

const lecturaBd = jest.fn();
const estado: { secreto: string | undefined } = { secreto: SECRET };

@Controller('integraciones/websaco3')
@UseGuards(FirmaWebsaco3Guard)
class ProbeController {
  @Get('propietarios')
  leer(@Query() query: ConsultaProbeDto) {
    lecturaBd(query.websaco3CopropiedadId);
    return { copropiedad: { nombre: 'Demo' }, unidades: [] };
  }
}

@Module({
  controllers: [ProbeController],
  providers: [
    {
      provide: ConfigService,
      useValue: {
        get: (clave: string) =>
          clave === 'app.websaco3HmacSecret' ? estado.secreto : undefined,
      },
    },
  ],
})
class ProbeModule {}

const ahoraSegundos = () => Math.floor(Date.now() / 1000);

const cabeceras = (
  urlRecibida: string,
  opciones: { secret?: string; ts?: number; method?: string } = {},
) => {
  const ts = String(opciones.ts ?? ahoraSegundos());
  const { path, rawQuery } = rutaYConsulta(urlRecibida);
  const firma = hmacSha256Hex(
    opciones.secret ?? SECRET,
    cadenaFirmaPropietarios({
      timestamp: ts,
      method: opciones.method ?? 'GET',
      path,
      rawQuery,
    }),
  );
  return {
    'X-Websaco-Timestamp': ts,
    'X-Websaco-Signature': `sha256=${firma}`,
  };
};

/**
 * Runs the guard on a real Nest/Express app with the project's global
 * configuration (prefix, ValidationPipe, envelope) and NO database: the probe
 * handler stands in for the PR 2b controller and records whether it was ever
 * reached.
 */
describe('FirmaWebsaco3Guard sobre una app HTTP real', () => {
  let app: INestApplication;
  const servidor = () => app.getHttpServer() as import('node:http').Server;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    configureApp(app, { env: 'development', corsOrigins: '' });
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    estado.secreto = SECRET;
    lecturaBd.mockClear();
  });

  it('una petición firmada llega al handler y recibe el sobre', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;

    const res = await request(servidor()).get(url).set(cabeceras(url));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      statusCode: 200,
      data: { copropiedad: { nombre: 'Demo' }, unidades: [] },
    });
    expect(lecturaBd).toHaveBeenCalledTimes(1);
  });

  it('el id en mayúscula se verifica tal cual se envió', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID.toUpperCase()}`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(200);
  });

  it('firma inválida con id malformado: 401 y no 400 (el guard corre antes del pipe)', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=no-es-un-id&extra=1`;

    const res = await request(servidor())
      .get(url)
      .set(
        cabeceras(url, { secret: 'otro-secreto-de-al-menos-32-caracteres' }),
      );

    expect(res.status).toBe(401);
    expect(lecturaBd).not.toHaveBeenCalled();
  });

  it('sin headers y sin query: 401, no 400', async () => {
    const res = await request(servidor()).get(RUTA);

    expect(res.status).toBe(401);
    expect(lecturaBd).not.toHaveBeenCalled();
  });

  it('firma válida con id malformado: pasa el guard y el DTO responde 400', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=no-es-un-id`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(400);
    expect(lecturaBd).not.toHaveBeenCalled();
  });

  it('firma válida con un parámetro extra: 400 por forbidNonWhitelisted', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}&otro=1`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(400);
  });

  it('la firma de un id no sirve para otro id', async () => {
    const firmada = cabeceras(`${RUTA}?websaco3CopropiedadId=${ID}`);

    await request(servidor())
      .get(`${RUTA}?websaco3CopropiedadId=${'a'.repeat(24)}`)
      .set(firmada)
      .expect(401);
  });

  it('la firma del GET no sirve con barra final ni con HEAD', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;
    const firmada = cabeceras(url);

    await request(servidor())
      .get(`${RUTA}/?websaco3CopropiedadId=${ID}`)
      .set(firmada)
      .expect(401);
    await request(servidor()).head(url).set(firmada).expect(401);
    expect(lecturaBd).not.toHaveBeenCalled();
  });

  it('un timestamp fuera de la ventana: 401', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;

    await request(servidor())
      .get(url)
      .set(cabeceras(url, { ts: ahoraSegundos() - 400 }))
      .expect(401);
  });

  it('sin secreto configurado: 401 aunque la firma sea correcta, y sin lectura', async () => {
    estado.secreto = undefined;
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(401);
    expect(lecturaBd).not.toHaveBeenCalled();
  });

  it('el 401 es opaco: mismo cuerpo para secreto ausente y firma incorrecta', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;
    const incorrecta = await request(servidor())
      .get(url)
      .set(
        cabeceras(url, { secret: 'otro-secreto-de-al-menos-32-caracteres' }),
      );
    estado.secreto = undefined;
    const sinSecreto = await request(servidor()).get(url).set(cabeceras(url));

    expect(incorrecta.status).toBe(401);
    expect(incorrecta.body).toEqual(sinSecreto.body);
    expect(JSON.stringify(incorrecta.body)).not.toContain(SECRET);
  });

  it('un header repetido en el cable: 401', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;
    const firmada = cabeceras(url);
    const puerto = (app.getHttpServer() as import('node:net').Server).address();
    const { port } = puerto as AddressInfo;

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: url,
          method: 'GET',
          headers: {
            'X-Websaco-Timestamp': [
              firmada['X-Websaco-Timestamp'],
              firmada['X-Websaco-Timestamp'],
            ],
            'X-Websaco-Signature': firmada['X-Websaco-Signature'],
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(401);
    expect(lecturaBd).not.toHaveBeenCalled();
  });
});

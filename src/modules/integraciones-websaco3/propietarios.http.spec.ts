import type { INestApplication } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { configureApp } from '../../app-setup';
import { hmacSha256Hex } from '../../common/utils/hmac';
import { Copropiedad } from '../../database/schemas/copropiedades/copropiedad.schema';
import { Inmueble } from '../../database/schemas/copropiedades/inmueble.schema';
import { Tercero } from '../../database/schemas/terceros/tercero.schema';
import { FirmaWebsaco3Guard } from './firma-websaco3.guard';
import { PropietariosController } from './propietarios.controller';
import { PropietariosService } from './propietarios.service';
import { cadenaFirmaPropietarios, rutaYConsulta } from './propietarios.firma';

const SECRET = 'propietarios-http-secret-0123456789abcdef';
const RUTA = '/api/v1/integraciones/websaco3/propietarios';
const ID = '507f1f77bcf86cd799439011';
const COPROPIEDAD_ID = new Types.ObjectId();
const TITULAR_ID = new Types.ObjectId();

/** Resolves like a Mongoose query: chainable and `lean()` as the terminal. */
const consulta = (leer: () => unknown) => {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'sort', 'limit']) q[m] = () => q;
  q.lean = () => Promise.resolve(leer());
  return q;
};

const estado = {
  copropiedades: [] as unknown[],
  inmuebles: [] as unknown[],
  terceros: [] as unknown[],
  falla: false,
};
const filtros = {
  copropiedades: jest.fn(),
  inmuebles: jest.fn(),
  terceros: jest.fn(),
};

const modelo = (
  clave: 'copropiedades' | 'inmuebles' | 'terceros',
): { find: (f: unknown) => unknown } => ({
  find: (filtro: unknown) => {
    filtros[clave](filtro);
    return consulta(() => {
      if (estado.falla) throw new Error('db caída');
      return estado[clave];
    });
  },
});

@Module({
  controllers: [PropietariosController],
  providers: [
    PropietariosService,
    FirmaWebsaco3Guard,
    {
      provide: ConfigService,
      useValue: {
        get: (clave: string) =>
          clave === 'app.websaco3HmacSecret' ? SECRET : undefined,
      },
    },
    {
      provide: getModelToken(Copropiedad.name),
      useValue: modelo('copropiedades'),
    },
    { provide: getModelToken(Inmueble.name), useValue: modelo('inmuebles') },
    { provide: getModelToken(Tercero.name), useValue: modelo('terceros') },
  ],
})
class ProbeModule {}

const cabeceras = (urlRecibida: string, method = 'GET') => {
  const ts = String(Math.floor(Date.now() / 1000));
  const { path, rawQuery } = rutaYConsulta(urlRecibida);
  const firma = hmacSha256Hex(
    SECRET,
    cadenaFirmaPropietarios({ timestamp: ts, method, path, rawQuery }),
  );
  return {
    'X-Websaco-Timestamp': ts,
    'X-Websaco-Signature': `sha256=${firma}`,
  };
};

/**
 * The real controller, guard, DTO, service and mapper on a real Nest/Express
 * app with the project's global configuration, with hand-rolled models: no
 * database.
 */
describe('GET /integraciones/websaco3/propietarios (HTTP)', () => {
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
    estado.copropiedades = [{ _id: COPROPIEDAD_ID, nombre: 'Edificio Demo' }];
    estado.inmuebles = [
      { codigo: '101', titularId: TITULAR_ID, tipoTitular: 'propietario' },
      { codigo: '102', titularId: null, tipoTitular: 'arrendatario' },
    ];
    estado.terceros = [
      {
        _id: TITULAR_ID,
        nombre: 'Ana Pérez',
        emails: ['a@x.co'],
        telefono: '3001',
        estado: 'active',
      },
    ];
    estado.falla = false;
    Object.values(filtros).forEach((f) => f.mockClear());
  });

  it('responde el sobre { statusCode, data } con el snapshot', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;

    const res = await request(servidor()).get(url).set(cabeceras(url));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      statusCode: 200,
      data: {
        copropiedad: { nombre: 'Edificio Demo' },
        unidades: [
          {
            codigo: '101',
            tipo: 'propietario',
            titular: { nombre: 'Ana Pérez', email: 'a@x.co', telefono: '3001' },
          },
          { codigo: '102', tipo: 'arrendatario', titular: null },
        ],
      },
    });
  });

  it('un id en mayúscula se firma tal cual y la búsqueda usa minúsculas', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID.toUpperCase()}`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(200);

    expect(filtros.copropiedades).toHaveBeenCalledWith({
      websaco3CopropiedadId: ID,
      usaGestionEdificios: true,
    });
  });

  it('401 gana sobre 400: firma inválida con id malformado', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=no-es-un-id`;

    await request(servidor()).get(url).expect(401);
    expect(filtros.copropiedades).not.toHaveBeenCalled();
  });

  it.each([
    ['sin id', ''],
    ['id de 23 caracteres', `?websaco3CopropiedadId=${ID.slice(0, 23)}`],
    ['id no hexadecimal', `?websaco3CopropiedadId=${'g'.repeat(24)}`],
    ['id con prefijo 0x', `?websaco3CopropiedadId=0x${ID.slice(0, 22)}`],
    ['id repetido', `?websaco3CopropiedadId=${ID}&websaco3CopropiedadId=${ID}`],
    ['parámetro extra', `?websaco3CopropiedadId=${ID}&otro=1`],
  ])('firma válida pero %s: 400 sin leer la base', async (_caso, query) => {
    const url = `${RUTA}${query}`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(400);

    expect(filtros.copropiedades).not.toHaveBeenCalled();
  });

  it('ignora X-CoProperty-Id: el tenant es la copropiedad encontrada', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;
    const otra = new Types.ObjectId().toHexString();

    await request(servidor())
      .get(url)
      .set(cabeceras(url))
      .set('X-CoProperty-Id', otra)
      .expect(200);

    expect(filtros.inmuebles).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD_ID,
    });
    expect(JSON.stringify(filtros.inmuebles.mock.calls)).not.toContain(otra);
    expect(JSON.stringify(filtros.terceros.mock.calls)).not.toContain(otra);
  });

  it('copropiedad inexistente: 404', async () => {
    estado.copropiedades = [];
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(404);
  });

  it('id duplicado en datos legados: 409', async () => {
    estado.copropiedades = [
      { _id: new Types.ObjectId(), nombre: 'A' },
      { _id: new Types.ObjectId(), nombre: 'B' },
    ];
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(409);
  });

  it('más de 2000 unidades: 422 demasiadas-unidades', async () => {
    estado.inmuebles = Array.from({ length: 2001 }, (_, i) => ({
      codigo: String(i),
      titularId: null,
      tipoTitular: 'propietario',
    }));
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;

    const res = await request(servidor()).get(url).set(cabeceras(url));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      statusCode: 422,
      error: 'demasiadas-unidades',
    });
  });

  it('una caída de la base es 500 (el llamador reintenta)', async () => {
    estado.falla = true;
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;

    await request(servidor()).get(url).set(cabeceras(url)).expect(500);
  });

  it('la firma del GET no sirve con barra final ni con HEAD', async () => {
    const url = `${RUTA}?websaco3CopropiedadId=${ID}`;
    const firmada = cabeceras(url);

    await request(servidor())
      .get(`${RUTA}/?websaco3CopropiedadId=${ID}`)
      .set(firmada)
      .expect(401);
    await request(servidor()).head(url).set(firmada).expect(401);
    expect(filtros.copropiedades).not.toHaveBeenCalled();
  });
});

import 'reflect-metadata';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import {
  HttpException,
  HttpStatus,
  RequestMethod,
  UnauthorizedException,
} from '@nestjs/common';
import { PUBLIC_KEY } from '../casl/check-ability.decorator';
import { EnlaceAccesoController } from './enlace-acceso.controller';

const TOKEN = 'a'.repeat(64);

function montar(opciones: { canje?: unknown; permitidos?: boolean[] } = {}) {
  const enlaces = {
    canjear: jest
      .fn()
      .mockResolvedValue(
        'canje' in opciones
          ? opciones.canje
          : { customToken: 'ct', copropiedadId: 'c1', destino: '/pqr' },
      ),
  };
  const respuestas = [...(opciones.permitidos ?? [true, true])];
  const limite = {
    permitir: jest
      .fn()
      .mockImplementation(() => Promise.resolve(respuestas.shift() ?? true)),
  };
  return {
    enlaces,
    limite,
    controlador: new EnlaceAccesoController(enlaces as never, limite as never),
  };
}

const req = { ip: '203.0.113.7' };

describe('EnlaceAccesoController — política', () => {
  const handler = (
    EnlaceAccesoController.prototype as unknown as Record<string, object>
  ).canjear;

  it('es POST /auth/enlace/canjear, @Public, sin guards y responde 200', () => {
    expect(Reflect.getMetadata(PATH_METADATA, EnlaceAccesoController)).toBe(
      'auth',
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('enlace/canjear');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, EnlaceAccesoController),
    ).toBeUndefined();
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });
});

describe('EnlaceAccesoController.canjear', () => {
  it('un enlace vigente devuelve el token personalizado, la copropiedad y el destino', async () => {
    const { controlador, enlaces } = montar();

    await expect(controlador.canjear({ token: TOKEN }, req)).resolves.toEqual({
      customToken: 'ct',
      copropiedadId: 'c1',
      destino: '/pqr',
    });
    expect(enlaces.canjear).toHaveBeenCalledWith(TOKEN);
  });

  it('vencido, desconocido, revocado o de una cuenta que ya no califica: 401 con el mismo mensaje', async () => {
    const { controlador } = montar({ canje: null });

    const intento = controlador.canjear({ token: TOKEN }, req);

    await expect(intento).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(intento).rejects.toThrow('El enlace no es válido o venció');
  });

  it('limita por IP y en total; pasado el límite responde 429 sin tocar el servicio', async () => {
    const { controlador, enlaces, limite } = montar({
      permitidos: [false, true],
    });

    const intento = controlador.canjear({ token: TOKEN }, req);

    await expect(intento).rejects.toBeInstanceOf(HttpException);
    await expect(intento).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(enlaces.canjear).not.toHaveBeenCalled();
    expect(limite.permitir).toHaveBeenCalledWith(
      'limite:enlace-canjear:ip:203.0.113.7',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('no hay cubeta global: el tráfico inválido de otras direcciones no deja afuera a los demás residentes', async () => {
    // Before: one shared bucket counted every request, valid or not, so
    // ~10 req/s of garbage from anywhere locked every resident out.
    const { controlador, enlaces, limite } = montar({
      permitidos: [true, false],
    });

    await expect(controlador.canjear({ token: TOKEN }, req)).resolves.toEqual(
      expect.objectContaining({ customToken: 'ct' }),
    );
    expect(enlaces.canjear).toHaveBeenCalled();
    expect(limite.permitir).toHaveBeenCalledTimes(1);
    expect(limite.permitir).not.toHaveBeenCalledWith(
      'limite:enlace-canjear:global',
      expect.any(Number),
      expect.any(Number),
    );
  });
});

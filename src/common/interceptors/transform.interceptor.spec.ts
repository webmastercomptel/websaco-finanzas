import { firstValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { TransformInterceptor } from './transform.interceptor';

const contextConEstado = (statusCode: number): ExecutionContext =>
  ({
    switchToHttp: () => ({ getResponse: () => ({ statusCode }) }),
  }) as unknown as ExecutionContext;

const handlerQueDevuelve = <T>(value: T): CallHandler<T> => ({
  handle: () => of(value),
});

const envolver = async <T>(value: T, statusCode = 200) =>
  firstValueFrom(
    new TransformInterceptor<T>().intercept(
      contextConEstado(statusCode),
      handlerQueDevuelve(value),
    ),
  );

describe('TransformInterceptor', () => {
  it('envuelve un objeto en { statusCode, data }', async () => {
    const perfil = { email: 'santiago@comptel.com' };

    await expect(envolver(perfil)).resolves.toEqual({
      statusCode: 200,
      data: perfil,
    });
  });

  it('reporta el código real, no un 200 asumido', async () => {
    // Un @HttpCode(202) o el 201 que Nest le pone a un POST tienen que
    // aparecer acá; si no, el cuerpo contradice la cabecera.
    await expect(envolver({ ok: true }, 201)).resolves.toEqual({
      statusCode: 201,
      data: { ok: true },
    });
  });

  it('envuelve un arreglo sin aplanarlo', async () => {
    // Un listado tiene que llegar como data: [...], no esparcido en la raíz.
    await expect(envolver([1, 2, 3])).resolves.toEqual({
      statusCode: 200,
      data: [1, 2, 3],
    });
  });

  it('envuelve un arreglo vacío en lugar de dejarlo pasar como nada', async () => {
    await expect(envolver([])).resolves.toEqual({ statusCode: 200, data: [] });
  });

  it('preserva null como dato legítimo', async () => {
    // null significa "no hay valor" y es una respuesta válida; convertirlo en
    // undefined haría que el cliente no pueda distinguirlo de un fallo.
    await expect(envolver(null)).resolves.toEqual({
      statusCode: 200,
      data: null,
    });
  });

  it('no vuelve a envolver anidando: envuelve lo que el handler devuelva', async () => {
    // Si un controlador arma el sobre a mano, termina duplicado. Este test
    // documenta ese síntoma para que se reconozca rápido.
    const aMano = { statusCode: 200, data: { x: 1 } };

    await expect(envolver(aMano)).resolves.toEqual({
      statusCode: 200,
      data: aMano,
    });
  });
});

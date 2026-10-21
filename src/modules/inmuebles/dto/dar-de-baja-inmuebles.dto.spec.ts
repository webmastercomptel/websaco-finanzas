import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DarDeBajaInmueblesDto } from './dar-de-baja-inmuebles.dto';

const dto = (codigos: unknown) =>
  plainToInstance(DarDeBajaInmueblesDto, { codigos });

describe('DarDeBajaInmueblesDto', () => {
  it('acepta una lista de códigos y los recorta', async () => {
    const d = dto(['  301 ', 'A-2']);

    expect(d.codigos).toEqual(['301', 'A-2']);
    expect(await validate(d)).toHaveLength(0);
  });

  it('rechaza una lista vacía y una de más de 1000', async () => {
    expect(await validate(dto([]))).not.toHaveLength(0);
    expect(
      await validate(dto(Array.from({ length: 1001 }, (_, i) => `U${i}`))),
    ).not.toHaveLength(0);
    expect(
      await validate(dto(Array.from({ length: 1000 }, (_, i) => `U${i}`))),
    ).toHaveLength(0);
  });

  it('rechaza códigos vacíos (también solo espacios), no-string o de más de 100 caracteres', async () => {
    expect(await validate(dto(['301', '   ']))).not.toHaveLength(0);
    expect(await validate(dto(['']))).not.toHaveLength(0);
    expect(await validate(dto([301]))).not.toHaveLength(0);
    expect(await validate(dto(['x'.repeat(101)]))).not.toHaveLength(0);
    expect(await validate(dto(['x'.repeat(100)]))).toHaveLength(0);
  });

  it('rechaza un cuerpo que no es una lista', async () => {
    expect(await validate(dto('301'))).not.toHaveLength(0);
    expect(await validate(dto(undefined))).not.toHaveLength(0);
  });
});

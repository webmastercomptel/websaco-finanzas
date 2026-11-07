import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BuscarAdministracionDto } from './buscar-administracion.dto';

const validar = (plano: Record<string, unknown>) => {
  const dto = plainToInstance(BuscarAdministracionDto, plano);
  return { dto, errores: validate(dto) };
};

describe('BuscarAdministracionDto', () => {
  it('recorta q y acepta un término válido sin límite', async () => {
    const { dto, errores } = validar({ q: '  acta  ' });

    expect(dto.q).toBe('acta');
    expect(dto.limite).toBeUndefined();
    expect(await errores).toHaveLength(0);
  });

  it('rechaza q demasiado corto, incluso si el relleno lo hace parecer largo', async () => {
    expect(await validar({ q: 'a' }).errores).not.toHaveLength(0);
    expect(await validar({ q: '  a  ' }).errores).not.toHaveLength(0);
    expect(await validar({}).errores).not.toHaveLength(0);
  });

  it('acota q a 64 caracteres y rechaza lo que no es texto', async () => {
    expect(await validar({ q: 'x'.repeat(64) }).errores).toHaveLength(0);
    expect(await validar({ q: 'x'.repeat(65) }).errores).not.toHaveLength(0);
    expect(await validar({ q: ['ab', 'cd'] }).errores).not.toHaveLength(0);
  });

  it('convierte limite a número y lo acota entre 1 y 20', async () => {
    const ok = validar({ q: 'acta', limite: '7' });

    expect(ok.dto.limite).toBe(7);
    expect(await ok.errores).toHaveLength(0);
    expect(await validar({ q: 'acta', limite: '0' }).errores).not.toHaveLength(
      0,
    );
    expect(await validar({ q: 'acta', limite: '21' }).errores).not.toHaveLength(
      0,
    );
    expect(
      await validar({ q: 'acta', limite: '2.5' }).errores,
    ).not.toHaveLength(0);
    expect(
      await validar({ q: 'acta', limite: 'abc' }).errores,
    ).not.toHaveLength(0);
  });

  it('el ValidationPipe global responde 400 ante un coPropertyId o cualquier campo desconocido', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const metadata = {
      type: 'query' as const,
      metatype: BuscarAdministracionDto,
    };

    await expect(
      pipe.transform({ q: 'acta', coPropertyId: 'otra' }, metadata),
    ).rejects.toThrow(BadRequestException);
    await expect(
      pipe.transform({ q: 'acta', cualquiera: '1' }, metadata),
    ).rejects.toThrow(BadRequestException);
    await expect(
      pipe.transform({ q: 'acta', limite: '3' }, metadata),
    ).resolves.toMatchObject({ q: 'acta', limite: 3 });
  });
});

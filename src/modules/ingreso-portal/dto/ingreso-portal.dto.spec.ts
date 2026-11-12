import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CanjearIngresoDto } from './canjear-ingreso.dto';
import { SolicitarIngresoDto } from './solicitar-ingreso.dto';

// The project's global pipe (`app-setup.ts`), instantiated the same way.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validar = (metatype: new () => object, cuerpo: unknown) =>
  pipe.transform(cuerpo, { type: 'body', metatype });

describe('SolicitarIngresoDto', () => {
  it('accepts an address, a non-address string and the 320-character edge', async () => {
    await expect(
      validar(SolicitarIngresoDto, { correo: 'ana@x.com' }),
    ).resolves.toEqual({ correo: 'ana@x.com' });
    await expect(
      validar(SolicitarIngresoDto, { correo: 'no-es-correo' }),
    ).resolves.toEqual({ correo: 'no-es-correo' });
    await expect(
      validar(SolicitarIngresoDto, { correo: 'a'.repeat(320) }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['empty body', {}],
    ['a number', { correo: 5 }],
    ['an object', { correo: { $ne: null } }],
    ['an array', { correo: ['a@x.com'] }],
    ['321 characters', { correo: 'a'.repeat(321) }],
    ['an extra property', { correo: 'a@x.com', otro: 1 }],
  ])('is a 400 for %s', async (_caso, cuerpo) => {
    await expect(validar(SolicitarIngresoDto, cuerpo)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('CanjearIngresoDto', () => {
  it('accepts any string up to 128 characters (the format is judged later, as a 401)', async () => {
    await expect(
      validar(CanjearIngresoDto, { token: 'ab'.repeat(32) }),
    ).resolves.toBeDefined();
    await expect(
      validar(CanjearIngresoDto, { token: 'hola' }),
    ).resolves.toBeDefined();
    await expect(
      validar(CanjearIngresoDto, { token: 'a'.repeat(128) }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['empty body', {}],
    ['a number', { token: 1 }],
    ['300 characters', { token: 'a'.repeat(300) }],
    ['129 characters', { token: 'a'.repeat(129) }],
    ['an extra property', { token: 'a'.repeat(64), otro: 1 }],
  ])('is a 400 for %s', async (_caso, cuerpo) => {
    await expect(validar(CanjearIngresoDto, cuerpo)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

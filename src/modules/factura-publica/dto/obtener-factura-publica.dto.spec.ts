import { ValidationPipe } from '@nestjs/common';
import { ObtenerFacturaPublicaDto } from './obtener-factura-publica.dto';

/** The same options as the global pipe (`app-setup.ts`). */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const validar = (cuerpo: object) =>
  pipe.transform(cuerpo, {
    type: 'body',
    metatype: ObtenerFacturaPublicaDto,
  });

describe('ObtenerFacturaPublicaDto', () => {
  it('acepta { token } con un token bien formado', async () => {
    await expect(validar({ token: 'ab12'.repeat(16) })).resolves.toEqual({
      token: 'ab12'.repeat(16),
    });
  });

  it('un token mal formado dentro de la forma NO es 400 (es 404 después): 64 no hex y vacío pasan el DTO', async () => {
    await expect(validar({ token: 'z'.repeat(64) })).resolves.toBeDefined();
    await expect(validar({ token: '' })).resolves.toBeDefined();
    await expect(validar({ token: 'hola' })).resolves.toBeDefined();
  });

  it.each([
    ['sin token', {}],
    ['token numérico', { token: 123 }],
    ['token de 300 caracteres', { token: 'a'.repeat(300) }],
    ['token de 129 caracteres', { token: 'a'.repeat(129) }],
    ['facturaId extra', { token: 'a'.repeat(64), facturaId: 'x' }],
    ['copropiedadId extra', { token: 'a'.repeat(64), copropiedadId: 'x' }],
  ])('responde 400 por la forma del cuerpo: %s', async (_nombre, cuerpo) => {
    await expect(validar(cuerpo)).rejects.toMatchObject({ status: 400 });
  });
});

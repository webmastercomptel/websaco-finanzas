import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CanjearEnlaceDto } from './canjear-enlace.dto';

const errores = async (cuerpo: object) =>
  (await validate(plainToInstance(CanjearEnlaceDto, cuerpo))).map(
    (e) => e.property,
  );

describe('CanjearEnlaceDto', () => {
  it('acepta un token de 64 caracteres hexadecimales', async () => {
    expect(await errores({ token: 'ab12'.repeat(16) })).toEqual([]);
  });

  it.each([
    [{}],
    [{ token: '' }],
    [{ token: 'xyz' }],
    [{ token: 'g'.repeat(64) }],
  ])('rechaza un token ausente o mal formado (%j)', async (cuerpo) => {
    expect(await errores(cuerpo)).toContain('token');
  });
});

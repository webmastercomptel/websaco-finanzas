import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConsultarPropietariosDto } from './consultar-propietarios.dto';

const ID = '507f1f77bcf86cd799439011';

const revisar = async (plano: Record<string, unknown>) => {
  const dto = plainToInstance(ConsultarPropietariosDto, plano);
  const errores = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, errores };
};

describe('ConsultarPropietariosDto', () => {
  it('acepta un id de 24 hex y lo deja igual', async () => {
    const { dto, errores } = await revisar({ websaco3CopropiedadId: ID });

    expect(errores).toHaveLength(0);
    expect(dto.websaco3CopropiedadId).toBe(ID);
  });

  it('acepta mayúsculas y las pasa a minúsculas', async () => {
    const { dto, errores } = await revisar({
      websaco3CopropiedadId: ID.toUpperCase(),
    });

    expect(errores).toHaveLength(0);
    expect(dto.websaco3CopropiedadId).toBe(ID);
  });

  it.each([
    ['falta', undefined],
    ['23 caracteres', ID.slice(0, 23)],
    ['25 caracteres', `${ID}a`],
    ['no hexadecimal', 'g'.repeat(24)],
    ['prefijo 0x', `0x${ID.slice(0, 22)}`],
    ['con espacios', ` ${ID.slice(0, 23)}`],
    ['repetido', [ID, ID]],
    ['no es texto', { $ne: null }],
  ])('rechaza el id: %s', async (_caso, valor) => {
    const { errores } = await revisar({ websaco3CopropiedadId: valor });

    expect(errores.length).toBeGreaterThan(0);
  });

  it('rechaza un parámetro extra (forbidNonWhitelisted)', async () => {
    const { errores } = await revisar({
      websaco3CopropiedadId: ID,
      otro: '1',
    });

    expect(errores.length).toBeGreaterThan(0);
  });
});

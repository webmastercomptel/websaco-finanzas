import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ActualizarCopropiedadDto,
  CrearCopropiedadDto,
} from './guardar-copropiedad.dto';

const ID_VALIDO = '64b7f0c2a1d4e5f6a7b8c9d0';

describe('CrearCopropiedadDto — websaco3CopropiedadId', () => {
  const validar = (plano: Record<string, unknown>) =>
    validate(plainToInstance(CrearCopropiedadDto, plano));

  it('acepta un ObjectId de 24 hex', async () => {
    expect(await validar({ websaco3CopropiedadId: ID_VALIDO })).toHaveLength(0);
  });

  it('acepta hex en mayúsculas', async () => {
    expect(
      await validar({ websaco3CopropiedadId: ID_VALIDO.toUpperCase() }),
    ).toHaveLength(0);
  });

  it('es opcional: el servicio decide cuándo hace falta', async () => {
    expect(await validar({ nombre: 'X' })).toHaveLength(0);
  });

  it.each([
    ['demasiado corto', '123'],
    ['no hexadecimal', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['23 caracteres', ID_VALIDO.slice(0, 23)],
    ['25 caracteres', `${ID_VALIDO}0`],
    ['con prefijo 0x', `0x${'a'.repeat(22)}`],
    ['con prefijo 0h', `0h${'a'.repeat(22)}`],
    ['con prefijo 0X en mayúsculas', `0X${'A'.repeat(22)}`],
    ['no es texto', 12345],
  ])('rechaza un id %s', async (_caso, valor) => {
    const errores = await validar({ websaco3CopropiedadId: valor });

    expect(errores).toHaveLength(1);
    expect(errores[0].property).toBe('websaco3CopropiedadId');
  });

  it('también se valida al actualizar', async () => {
    const errores = await validate(
      plainToInstance(ActualizarCopropiedadDto, {
        websaco3CopropiedadId: '123',
      }),
    );

    expect(errores).toHaveLength(1);
  });
});

describe('CamposCopropiedadDto — comptableEmpresaId', () => {
  const validar = (plano: Record<string, unknown>) =>
    validate(plainToInstance(ActualizarCopropiedadDto, plano));

  it('acepta un ObjectId de 24 hex, en minúsculas o mayúsculas', async () => {
    expect(await validar({ comptableEmpresaId: ID_VALIDO })).toHaveLength(0);
    expect(
      await validar({ comptableEmpresaId: ID_VALIDO.toUpperCase() }),
    ).toHaveLength(0);
  });

  it('acepta null para desvincular la copropiedad de Comptable', async () => {
    expect(await validar({ comptableEmpresaId: null })).toHaveLength(0);
  });

  it.each([
    ['vacío', ''],
    ['demasiado corto', '123'],
    ['con prefijo 0x', `0x${'a'.repeat(22)}`],
    ['no es texto', 12345],
  ])('rechaza un id %s con un mensaje en español', async (_caso, valor) => {
    const errores = await validar({ comptableEmpresaId: valor });

    expect(errores).toHaveLength(1);
    expect(errores[0].property).toBe('comptableEmpresaId');
    expect(Object.values(errores[0].constraints ?? {})[0]).toContain(
      'Empresa en Comptable',
    );
  });
});

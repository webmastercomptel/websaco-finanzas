import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListarTercerosDto } from './listar-terceros.dto';

const validar = (plano: Record<string, unknown>) => {
  const dto = plainToInstance(ListarTercerosDto, plano);
  return { dto, errores: validate(dto) };
};

describe('ListarTercerosDto · email', () => {
  it('recorta y pasa a minúsculas el correo', async () => {
    const { dto, errores } = validar({ email: '  Ana.Perez@Correo.COM ' });

    expect(dto.email).toBe('ana.perez@correo.com');
    expect(await errores).toHaveLength(0);
  });

  it('es opcional', async () => {
    const { dto, errores } = validar({});

    expect(dto.email).toBeUndefined();
    expect(await errores).toHaveLength(0);
  });

  it('rechaza un valor que no parece un correo', async () => {
    for (const email of ['ana', 'ana@', '@correo.com', '', '   ']) {
      const { errores } = validar({ email });
      expect(await errores).not.toHaveLength(0);
    }
  });

  it('rechaza más de 120 caracteres', async () => {
    const largo = `${'a'.repeat(120)}@correo.com`;
    const { errores } = validar({ email: largo });

    expect(await errores).not.toHaveLength(0);
  });

  it('rechaza lo que no es texto: operadores de Mongo y arreglos', async () => {
    const operador = validar({ email: { $ne: '' } });
    const arreglo = validar({ email: ['a@b.co', 'c@d.co'] });

    expect(await operador.errores).not.toHaveLength(0);
    expect(await arreglo.errores).not.toHaveLength(0);
  });

  it('rechaza cadenas con aspecto de operador o de expresión regular', async () => {
    for (const email of [
      '{"$ne":""}',
      '.*@correo.com',
      '(a+)+@correo.com',
      'a@b.co|c@d.co',
    ]) {
      const { errores } = validar({ email });
      expect(await errores).not.toHaveLength(0);
    }
  });
});

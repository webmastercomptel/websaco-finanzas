import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BuscarDto } from './buscar.dto';

const validar = (plano: Record<string, unknown>) => {
  const dto = plainToInstance(BuscarDto, plano);
  return { dto, errores: validate(dto) };
};

describe('BuscarDto', () => {
  it('recorta q y acepta un término válido sin límite', async () => {
    const { dto, errores } = validar({ q: '  1041  ' });

    expect(dto.q).toBe('1041');
    expect(dto.limite).toBeUndefined();
    expect(await errores).toHaveLength(0);
  });

  it('rechaza q demasiado corto, incluso si el relleno lo hace parecer largo', async () => {
    const corto = validar({ q: 'a' });
    const relleno = validar({ q: '  a  ' });
    const ausente = validar({});

    expect(await corto.errores).not.toHaveLength(0);
    expect(await relleno.errores).not.toHaveLength(0);
    expect(await ausente.errores).not.toHaveLength(0);
  });

  it('rechaza q de más de 64 caracteres y valores que no son texto', async () => {
    const largo = validar({ q: 'x'.repeat(65) });
    const noTexto = validar({ q: ['ab', 'cd'] });

    expect(await largo.errores).not.toHaveLength(0);
    expect(await noTexto.errores).not.toHaveLength(0);
  });

  it('convierte limite a número y lo acota entre 1 y 20', async () => {
    const ok = validar({ q: '1041', limite: '7' });
    const cero = validar({ q: '1041', limite: '0' });
    const enorme = validar({ q: '1041', limite: '21' });
    const decimal = validar({ q: '1041', limite: '2.5' });
    const texto = validar({ q: '1041', limite: 'abc' });

    expect(ok.dto.limite).toBe(7);
    expect(await ok.errores).toHaveLength(0);
    expect(await cero.errores).not.toHaveLength(0);
    expect(await enorme.errores).not.toHaveLength(0);
    expect(await decimal.errores).not.toHaveLength(0);
    expect(await texto.errores).not.toHaveLength(0);
  });
});

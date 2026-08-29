import { Types } from 'mongoose';
import { InmueblesService } from './inmuebles.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const fila = (over: Record<string, unknown> = {}) => ({
  codigo: '301',
  ...over,
});

/** Records every code checked and every unit written; codes in `existentes`
 *  are reported as already taken. */
const inmueblesModeloCon = (existentes: string[] = []) => {
  const escrituras: Record<string, unknown>[] = [];
  return {
    escrituras,
    exists: jest.fn(({ code }: Filtro) => ({
      exec: () =>
        Promise.resolve(
          existentes.includes(code as string) ? { _id: 'x' } : null,
        ),
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve({ _id: { toString: () => 'inm-nuevo' } });
    }),
  };
};

/** `porIdentificacion` maps an existing party's identification to its id. */
const tercerosModeloCon = (porIdentificacion: Record<string, string> = {}) => {
  const creados: Record<string, unknown>[] = [];
  return {
    creados,
    findOne: jest.fn(({ identificationNumber }: Filtro) => ({
      exec: () => {
        const id = porIdentificacion[identificationNumber as string];
        return Promise.resolve(id ? { _id: id } : null);
      },
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      creados.push(doc);
      return Promise.resolve({ _id: 'ter-nuevo' });
    }),
  };
};

const tenant = {
  resolveCoPropertyId: () => COP,
} as unknown as TenantContextService;

describe('InmueblesService.importar', () => {
  it('crea cada fila como una unidad, contando el total', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
    );

    const resultado = await service.importar({
      filas: [fila({ codigo: '301' }), fila({ codigo: '302' })],
    });

    expect(resultado).toEqual({ total: 2, creados: 2, errores: [] });
    expect(inmuebles.escrituras).toHaveLength(2);
  });

  it('una fila con código repetido falla sola, sin abortar el resto', async () => {
    // Un archivo de 400 filas con tres typos no debería tener que
    // resubirse entero.
    const inmuebles = inmueblesModeloCon(['301']);
    const terceros = tercerosModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
    );

    const resultado = await service.importar({
      filas: [fila({ codigo: '301' }), fila({ codigo: '302' })],
    });

    expect(resultado.creados).toBe(1);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0]).toMatchObject({ fila: 1, codigo: '301' });
    expect(resultado.errores[0].mensaje).toContain('301');
  });

  it('reutiliza un tercero existente por identificación, sin duplicarlo', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon({ '123456': 'ter-1' });
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
    );

    await service.importar({
      filas: [
        fila({
          codigo: '301',
          nombreTitular: 'Ana Pérez',
          numeroIdentificacionTitular: '123456',
        }),
      ],
    });

    expect(terceros.create).not.toHaveBeenCalled();
    expect(inmuebles.escrituras[0]).toMatchObject({ holderId: 'ter-1' });
  });

  it('crea un tercero nuevo cuando la identificación no coincide con ninguno', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
    );

    await service.importar({
      filas: [fila({ codigo: '301', nombreTitular: 'Ana Pérez' })],
    });

    expect(terceros.creados[0]).toMatchObject({
      coPropertyId: COP,
      name: 'Ana Pérez',
    });
    expect(inmuebles.escrituras[0]).toMatchObject({ holderId: 'ter-nuevo' });
  });

  it('deja la unidad sin titular cuando la fila no trae ninguno: se carga antes que sus papeles', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
    );

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(terceros.create).not.toHaveBeenCalled();
    expect(inmuebles.escrituras[0].holderId).toBeUndefined();
  });

  it('escribe siempre la copropiedad activa, nunca una de la fila', async () => {
    const inmuebles = inmueblesModeloCon();
    const terceros = tercerosModeloCon();
    const service = new InmueblesService(
      inmuebles as never,
      terceros as never,
      tenant,
    );

    await service.importar({ filas: [fila({ codigo: '301' })] });

    expect(inmuebles.escrituras[0]).toMatchObject({ coPropertyId: COP });
  });
});

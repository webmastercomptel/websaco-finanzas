import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InmueblesService } from './inmuebles.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const documento = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'inm-1' },
  code: '301',
  block: 'Torre A',
  zone: null,
  usage: null,
  area: 72,
  participationFactor: 1.8452,
  holderId: null,
  holderKind: 'propietario',
  holderResides: true,
  collectionStatus: 'al_dia',
  status: 'active',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

/** Chainable stub; records the filter every call was made with. */
const modeloCon = (filas: unknown[], total = filas.length) => {
  const filtros: Filtro[] = [];
  const cadena = {
    populate: () => cadena,
    sort: () => cadena,
    skip: () => cadena,
    limit: () => cadena,
    exec: () => Promise.resolve(filas),
  };
  return {
    filtros,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return cadena;
    }),
    findOne: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return {
        populate: () => ({ exec: () => Promise.resolve(filas[0] ?? null) }),
      };
    }),
    countDocuments: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve(total) };
    }),
  };
};

/** Stub for the `terceros` model — only `find(...).distinct('_id')` is ever
 *  called on it, to resolve which parties match a name search. */
const terceroModeloCon = (idsQueMatchean: unknown[] = []) => {
  const filtros: Filtro[] = [];
  return {
    filtros,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return {
        distinct: () => ({ exec: () => Promise.resolve(idsQueMatchean) }),
      };
    }),
  };
};

const tenantQueDevuelve = (id: Types.ObjectId | null): TenantContextService =>
  ({
    resolveCoPropertyId: () => {
      if (id === null) throw new ForbiddenException('sin copropiedad activa');
      return id;
    },
  }) as unknown as TenantContextService;

describe('InmueblesService.findAll', () => {
  it('filtra SIEMPRE por la copropiedad activa', async () => {
    // La ley de tenancy: ninguna consulta sale sin este filtro.
    const modelo = modeloCon([documento()]);
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      tenantQueDevuelve(COP),
      {} as never,
      {} as never,
      {} as never,
    );

    await service.findAll({});

    for (const filtro of modelo.filtros) {
      expect(filtro.coPropertyId).toBe(COP);
    }
  });

  it('falla cerrado cuando no hay copropiedad activa', async () => {
    const modelo = modeloCon([]);
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      tenantQueDevuelve(null),
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.findAll({})).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Y sin llegar a consultar: el tenant se resuelve antes de armar nada.
    expect(modelo.find).not.toHaveBeenCalled();
  });

  it('siempre filtra por status activo: no hay estado que alternar', async () => {
    const modelo = modeloCon([]);
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      tenantQueDevuelve(COP),
      {} as never,
      {} as never,
      {} as never,
    );

    await service.findAll({});

    expect(modelo.filtros[0].status).toBe('active');
  });

  it('escapa la búsqueda para que no actúe como expresión regular', async () => {
    // Un paréntesis suelto tiraría la consulta; uno malicioso puede clavar la
    // base al 100%. El texto del buscador es entrada de usuario.
    const modelo = modeloCon([]);
    const service = new InmueblesService(
      modelo as never,
      terceroModeloCon() as never,
      tenantQueDevuelve(COP),
      {} as never,
      {} as never,
      {} as never,
    );

    await service.findAll({ buscar: 'Torre A (301)' });

    const or = modelo.filtros[0].$or as Array<{ code?: { $regex: string } }>;
    expect(or[0].code!.$regex).toBe('Torre A \\(301\\)');
  });

  it('cuenta con el MISMO filtro que lista', async () => {
    // Un total que no concuerda con las filas convierte la paginación en una
    // mentira: "1-50 de 900" cuando en realidad hay 3.
    const modelo = modeloCon([documento()], 137);
    const service = new InmueblesService(
      modelo as never,
      terceroModeloCon() as never,
      tenantQueDevuelve(COP),
      {} as never,
      {} as never,
      {} as never,
    );

    const resultado = await service.findAll({ buscar: '301' });

    expect(modelo.filtros[0]).toEqual(modelo.filtros[1]);
    expect(resultado.total).toBe(137);
  });

  describe('buscar por nombre del titular', () => {
    it('resuelve terceros cuyo nombre matchea y los incluye vía holderId', async () => {
      const modelo = modeloCon([]);
      const terceroId = new Types.ObjectId();
      const terceros = terceroModeloCon([terceroId]);
      const service = new InmueblesService(
        modelo as never,
        terceros as never,
        tenantQueDevuelve(COP),
        {} as never,
        {} as never,
        {} as never,
      );

      await service.findAll({ buscar: 'Ana Pérez' });

      expect(terceros.filtros[0]).toMatchObject({
        coPropertyId: COP,
        name: { $regex: 'Ana Pérez', $options: 'i' },
      });
      const or = modelo.filtros[0].$or as Array<{
        code?: unknown;
        holderId?: { $in: unknown[] };
      }>;
      expect(or[1].holderId!.$in).toEqual([terceroId]);
    });

    it('sin terceros que matcheen, el filtro sigue siendo válido (solo busca por código)', async () => {
      const modelo = modeloCon([]);
      const service = new InmueblesService(
        modelo as never,
        terceroModeloCon([]) as never,
        tenantQueDevuelve(COP),
        {} as never,
        {} as never,
        {} as never,
      );

      await service.findAll({ buscar: 'Nadie Así' });

      const or = modelo.filtros[0].$or as unknown[];
      expect(or).toHaveLength(1);
    });
  });

  it('devuelve el contrato en español', async () => {
    const modelo = modeloCon([documento()]);
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      tenantQueDevuelve(COP),
      {} as never,
      {} as never,
      {} as never,
    );

    const { items } = await service.findAll({});

    expect(items[0]).toMatchObject({
      codigo: '301',
      bloque: 'Torre A',
      coeficiente: 1.8452,
      titular: null,
    });
  });

  it('usa 50 por página por defecto', async () => {
    const modelo = modeloCon([]);
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      tenantQueDevuelve(COP),
      {} as never,
      {} as never,
      {} as never,
    );

    const resultado = await service.findAll({});

    expect(resultado).toMatchObject({ pagina: 1, porPagina: 50 });
  });
});

describe('InmueblesService.findOne', () => {
  it('busca por id Y copropiedad en la misma consulta', async () => {
    // Traer por id y comparar después ya habría leído la fila de otro
    // edificio, y el día que alguien olvide la comparación se sirve.
    const modelo = modeloCon([documento()]);
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      tenantQueDevuelve(COP),
      {} as never,
      {} as never,
      {} as never,
    );

    await service.findOne('inm-1');

    expect(modelo.filtros[0]).toEqual({ _id: 'inm-1', coPropertyId: COP });
  });

  it('responde "no existe" para un inmueble de otra copropiedad', async () => {
    // Decirle a alguien que el id existe pero es ajeno le confirma la
    // existencia de datos de otro edificio.
    const modelo = modeloCon([]);
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      tenantQueDevuelve(COP),
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.findOne('inm-ajeno')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

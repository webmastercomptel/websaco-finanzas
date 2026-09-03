import { ConflictException, NotFoundException } from '@nestjs/common';
import { CuentasContablesService } from './cuentas-contables.service';

type Filtro = Record<string, unknown>;
const COP = 'cop-1';

const cuentaDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'cta-1' },
  code: '11050501',
  name: 'Caja General',
  requiresTercero: false,
  cashFlow: true,
  profitCenterCode: null,
  destinationCenterCode: null,
  requiresCrossDocument: false,
  taxType: null,
  taxRate: 0,
  active: true,
  ...over,
});

const modeloCon = (filas: unknown[], opts: { duplicado?: boolean } = {}) => {
  const filtros: Filtro[] = [];
  const cadena = {
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
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(filas[0] ?? null),
    })),
    countDocuments: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve(filas.length) };
    }),
    exists: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return {
        exec: () => Promise.resolve(opts.duplicado ? { _id: 'x' } : null),
      };
    }),
    create: jest.fn((doc: Record<string, unknown>) =>
      Promise.resolve(cuentaDoc(doc)),
    ),
    findOneAndUpdate: jest.fn(
      (_filtro: Filtro, _update: Record<string, unknown>) => ({
        exec: () => Promise.resolve(cuentaDoc()),
      }),
    ),
  };
};

const tenant = () => ({ resolveCoPropertyId: () => COP }) as never;

describe('CuentasContablesService.findAll', () => {
  it('sin filtro de estado, muestra solo las activas — no las inactivas', async () => {
    // Regresión: una versión anterior invertía la comparación
    // (`estado === 'activo'`) y con `estado` sin enviar terminaba filtrando
    // por `active: false`, mostrando cuentas inactivas por defecto.
    const modelo = modeloCon([cuentaDoc()]);
    const service = new CuentasContablesService(modelo as never, tenant());

    await service.findAll({});

    expect(modelo.filtros[0].active).toBe(true);
  });

  it('estado=inactivo muestra solo las inactivas', async () => {
    const modelo = modeloCon([]);
    const service = new CuentasContablesService(modelo as never, tenant());

    await service.findAll({ estado: 'inactivo' });

    expect(modelo.filtros[0].active).toBe(false);
  });

  it('estado=todos no filtra por active', async () => {
    const modelo = modeloCon([]);
    const service = new CuentasContablesService(modelo as never, tenant());

    await service.findAll({ estado: 'todos' });

    expect(modelo.filtros[0]).not.toHaveProperty('active');
  });

  it('busca por código o por nombre', async () => {
    const modelo = modeloCon([]);
    const service = new CuentasContablesService(modelo as never, tenant());

    await service.findAll({ buscar: 'Caja' });

    expect(modelo.filtros[0].$or).toEqual([
      { code: { $regex: 'Caja', $options: 'i' } },
      { name: { $regex: 'Caja', $options: 'i' } },
    ]);
  });
});

describe('CuentasContablesService.findOne', () => {
  it('responde "no existe" cuando no hay fila', async () => {
    const modelo = modeloCon([]);
    const service = new CuentasContablesService(modelo as never, tenant());

    await expect(service.findOne('cta-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('CuentasContablesService.create', () => {
  it('rechaza un código repetido', async () => {
    const modelo = modeloCon([], { duplicado: true });
    const service = new CuentasContablesService(modelo as never, tenant());

    await expect(
      service.create({ codigo: '11050501', nombre: 'Otra' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('crea con los defaults correctos cuando los flags no vienen', async () => {
    const modelo = modeloCon([]);
    const service = new CuentasContablesService(modelo as never, tenant());

    await service.create({ codigo: '11050502', nombre: 'Banco' });

    expect(modelo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        coPropertyId: COP,
        code: '11050502',
        name: 'Banco',
        requiresTercero: false,
        cashFlow: false,
        requiresCrossDocument: false,
        taxRate: 0,
      }),
    );
  });
});

describe('CuentasContablesService.update', () => {
  it('solo escribe los campos enviados', async () => {
    const modelo = modeloCon([cuentaDoc()]);
    const service = new CuentasContablesService(modelo as never, tenant());

    await service.update('cta-1', { nombre: 'Caja Principal' });

    const [, update] = modelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).toEqual({ name: 'Caja Principal' });
  });

  it('responde "no existe" cuando el id no corresponde a ninguna', async () => {
    const modelo = modeloCon([cuentaDoc()]);
    modelo.findOneAndUpdate = jest.fn(() => ({
      exec: () => Promise.resolve(null),
    })) as never;
    const service = new CuentasContablesService(modelo as never, tenant());

    await expect(
      service.update('cta-ajena', { nombre: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza chocar el código con otra cuenta', async () => {
    const modelo = modeloCon([cuentaDoc()], { duplicado: true });
    const service = new CuentasContablesService(modelo as never, tenant());

    await expect(
      service.update('cta-1', { codigo: '11050501' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

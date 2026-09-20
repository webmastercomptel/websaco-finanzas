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
  profitCenter: false,
  destinationCenter: false,
  requiresCrossDocument: false,
  appliesTax: false,
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
    deleteOne: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve({ deletedCount: 1 }) };
    }),
  };
};

const tenant = () => ({ resolveCoPropertyId: () => COP }) as never;

const modeloExists = (existe: boolean) => ({
  exists: jest.fn(() => ({
    exec: () => Promise.resolve(existe ? { _id: 'x' } : null),
  })),
});

const crearServicio = (
  modelo: ReturnType<typeof modeloCon>,
  opts: {
    enConceptos?: boolean;
    enAsientos?: boolean;
    enCopropiedad?: boolean;
  } = {},
): CuentasContablesService =>
  new CuentasContablesService(
    modelo as never,
    modeloExists(opts.enConceptos ?? false) as never,
    modeloExists(opts.enAsientos ?? false) as never,
    modeloExists(opts.enCopropiedad ?? false) as never,
    tenant(),
  );

describe('CuentasContablesService.findAll', () => {
  it('sin filtro de estado, muestra solo las activas — no las inactivas', async () => {
    // Regresión: una versión anterior invertía la comparación
    // (`estado === 'activo'`) y con `estado` sin enviar terminaba filtrando
    // por `active: false`, mostrando cuentas inactivas por defecto.
    const modelo = modeloCon([cuentaDoc()]);
    const service = crearServicio(modelo);

    await service.findAll({});

    expect(modelo.filtros[0].active).toBe(true);
  });

  it('estado=inactivo muestra solo las inactivas', async () => {
    const modelo = modeloCon([]);
    const service = crearServicio(modelo);

    await service.findAll({ estado: 'inactivo' });

    expect(modelo.filtros[0].active).toBe(false);
  });

  it('estado=todos no filtra por active', async () => {
    const modelo = modeloCon([]);
    const service = crearServicio(modelo);

    await service.findAll({ estado: 'todos' });

    expect(modelo.filtros[0]).not.toHaveProperty('active');
  });

  it('busca por código o por nombre', async () => {
    const modelo = modeloCon([]);
    const service = crearServicio(modelo);

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
    const service = crearServicio(modelo);

    await expect(service.findOne('cta-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('CuentasContablesService.create', () => {
  it('rechaza un código repetido', async () => {
    const modelo = modeloCon([], { duplicado: true });
    const service = crearServicio(modelo);

    await expect(
      service.create({ codigo: '11050501', nombre: 'Otra' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('crea con los defaults correctos cuando los flags no vienen', async () => {
    const modelo = modeloCon([]);
    const service = crearServicio(modelo);

    await service.create({ codigo: '11050502', nombre: 'Banco' });

    expect(modelo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        coPropertyId: COP,
        code: '11050502',
        name: 'Banco',
        requiresTercero: false,
        isBank: false,
        cashFlow: false,
        requiresCrossDocument: false,
        taxRate: 0,
      }),
    );
  });

  it('crea una cuenta marcada como banco cuando esBanco viene en true', async () => {
    const modelo = modeloCon([]);
    const service = crearServicio(modelo);

    await service.create({
      codigo: '11050503',
      nombre: 'Bancolombia',
      esBanco: true,
    });

    expect(modelo.create).toHaveBeenCalledWith(
      expect.objectContaining({ isBank: true }),
    );
  });
});

describe('CuentasContablesService.update', () => {
  it('solo escribe los campos enviados', async () => {
    const modelo = modeloCon([cuentaDoc()]);
    const service = crearServicio(modelo);

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
    const service = crearServicio(modelo);

    await expect(
      service.update('cta-ajena', { nombre: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza chocar el código con otra cuenta', async () => {
    const modelo = modeloCon([cuentaDoc()], { duplicado: true });
    const service = crearServicio(modelo);

    await expect(
      service.update('cta-1', { codigo: '11050501' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('actualiza esBanco a isBank', async () => {
    const modelo = modeloCon([cuentaDoc()]);
    const service = crearServicio(modelo);

    await service.update('cta-1', { esBanco: true });

    const [, update] = modelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).toEqual({ isBank: true });
  });
});

describe('CuentasContablesService.importar', () => {
  const CODIGO_COPROPIEDAD = '0001';

  /** Records every code checked and every doc written; codes in `existentes`
   *  are reported as already taken — same shape as the inmuebles import
   *  spec's per-code model, since `importar` here is per-row, not a single
   *  global duplicate switch like `modeloCon`'s `opts.duplicado`. */
  const modeloImportarCon = (existentes: string[] = []) => {
    const creadas: Record<string, unknown>[] = [];
    return {
      creadas,
      exists: jest.fn(({ code }: Filtro) => ({
        exec: () =>
          Promise.resolve(
            existentes.includes(code as string) ? { _id: 'x' } : null,
          ),
      })),
      create: jest.fn((doc: Record<string, unknown>) => {
        creadas.push(doc);
        return Promise.resolve(cuentaDoc(doc));
      }),
    };
  };

  /** `copropiedades.findById(coPropertyId).exec()` — the per-row
   *  `codigoCopropiedad` check reads `.code` from this. Defaults to
   *  matching every `fila` below so existing tests are unaffected; only the
   *  mismatch test overrides it. */
  const copropiedadModeloCon = (code: string = CODIGO_COPROPIEDAD) => ({
    findById: jest.fn(() => ({ exec: () => Promise.resolve({ code }) })),
  });

  const servicioImportar = (
    modelo: ReturnType<typeof modeloImportarCon>,
    codigoCopropiedad: string = CODIGO_COPROPIEDAD,
  ): CuentasContablesService =>
    new CuentasContablesService(
      modelo as never,
      {} as never,
      {} as never,
      copropiedadModeloCon(codigoCopropiedad) as never,
      tenant(),
    );

  it('crea cada fila como una cuenta, contando el total', async () => {
    const modelo = modeloImportarCon();
    const service = servicioImportar(modelo);

    const resultado = await service.importar({
      filas: [
        {
          codigo: '11050501',
          nombre: 'Caja',
          codigoCopropiedad: CODIGO_COPROPIEDAD,
        },
        {
          codigo: '11050502',
          nombre: 'Banco',
          codigoCopropiedad: CODIGO_COPROPIEDAD,
        },
      ],
    });

    expect(resultado).toEqual({ total: 2, creados: 2, errores: [] });
    expect(modelo.creadas).toHaveLength(2);
  });

  it('una fila con código repetido falla sola, sin abortar el resto', async () => {
    // Un archivo de 400 filas con tres typos no debería tener que
    // resubirse entero.
    const modelo = modeloImportarCon(['11050501']);
    const service = servicioImportar(modelo);

    const resultado = await service.importar({
      filas: [
        {
          codigo: '11050501',
          nombre: 'Caja',
          codigoCopropiedad: CODIGO_COPROPIEDAD,
        },
        {
          codigo: '11050502',
          nombre: 'Banco',
          codigoCopropiedad: CODIGO_COPROPIEDAD,
        },
      ],
    });

    expect(resultado.creados).toBe(1);
    expect(resultado.errores).toHaveLength(1);
    expect(resultado.errores[0]).toMatchObject({
      fila: 1,
      codigo: '11050501',
    });
    expect(resultado.errores[0].mensaje).toContain('11050501');
  });

  it('reenvía los flags booleanos y la tasa de impuesto de cada fila', async () => {
    const modelo = modeloImportarCon();
    const service = servicioImportar(modelo);

    await service.importar({
      filas: [
        {
          codigo: '11050501',
          nombre: 'Caja',
          codigoCopropiedad: CODIGO_COPROPIEDAD,
          aplicaImpuesto: true,
          tasaImpuesto: 19,
        },
      ],
    });

    expect(modelo.creadas[0]).toMatchObject({
      appliesTax: true,
      taxRate: 19,
    });
  });

  it('una fila con código de copropiedad que no coincide falla sola, el resto sigue', async () => {
    // A diferencia de InmueblesService.importar (que borra el listado antes
    // de escribir), este import nunca borra nada — así que un código
    // equivocado puede fallar fila por fila, igual que un código de cuenta
    // repetido, sin necesidad de abortar el archivo entero primero.
    const modelo = modeloImportarCon();
    const service = servicioImportar(modelo, CODIGO_COPROPIEDAD);

    const resultado = await service.importar({
      filas: [
        {
          codigo: '11050501',
          nombre: 'Caja',
          codigoCopropiedad: CODIGO_COPROPIEDAD,
        },
        { codigo: '11050502', nombre: 'Banco', codigoCopropiedad: 'OTRA' },
      ],
    });

    expect(resultado.creados).toBe(1);
    expect(resultado.errores).toEqual([
      {
        fila: 2,
        codigo: '11050502',
        mensaje:
          'El código de copropiedad "OTRA" no coincide con el de la copropiedad activa (0001)',
      },
    ]);
  });
});

describe('CuentasContablesService.delete', () => {
  it('elimina una cuenta sin uso', async () => {
    const modelo = modeloCon([cuentaDoc()]);
    const service = crearServicio(modelo);

    await service.delete('cta-1');

    expect(modelo.deleteOne).toHaveBeenCalledWith({
      _id: 'cta-1',
      coPropertyId: COP,
    });
  });

  it('rechaza eliminar una cuenta asignada a un cargo', async () => {
    const modelo = modeloCon([cuentaDoc()]);
    const service = crearServicio(modelo, { enConceptos: true });

    await expect(service.delete('cta-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(modelo.deleteOne).not.toHaveBeenCalled();
  });

  it('rechaza eliminar una cuenta con movimientos contables', async () => {
    const modelo = modeloCon([cuentaDoc()]);
    const service = crearServicio(modelo, { enAsientos: true });

    await expect(service.delete('cta-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(modelo.deleteOne).not.toHaveBeenCalled();
  });

  it('rechaza eliminar una cuenta configurada en la copropiedad', async () => {
    const modelo = modeloCon([cuentaDoc()]);
    const service = crearServicio(modelo, { enCopropiedad: true });

    await expect(service.delete('cta-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(modelo.deleteOne).not.toHaveBeenCalled();
  });

  it('responde "no existe" cuando el id no corresponde a ninguna', async () => {
    const modelo = modeloCon([]);
    const service = crearServicio(modelo);

    await expect(service.delete('cta-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

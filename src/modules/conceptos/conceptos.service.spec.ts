import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ConceptosService } from './conceptos.service';

type Filtro = Record<string, unknown>;

const COP_ID = '507f1f77bcf86cd799439011';
const CON_ID = '507f1f77bcf86cd799439022';
const CUENTA_DEBITO_ID = '507f1f77bcf86cd799439033';
const CUENTA_CREDITO_ID = '507f1f77bcf86cd799439044';

const documento = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => CON_ID },
  coPropertyId: { toString: () => COP_ID },
  name: 'Administración',
  kind: 'administracion',
  taxRate: 0,
  sortOrder: 100,
  cuentaDebitoId: null,
  cuentaCreditoId: null,
  liquidaMora: false,
  availableAsNovedad: false,
  isSystem: false,
  ...over,
});

/** Chainable stub; records every filter and write it was called with. */
const modeloCon = (
  filas: unknown[],
  opts: { duplicadoNombre?: boolean; duplicadoTipo?: boolean } = {},
) => {
  const filtros: Filtro[] = [];
  const escrituras: Record<string, unknown>[] = [];
  const cadenaFind = {
    populate: () => cadenaFind,
    sort: () => cadenaFind,
    limit: () => cadenaFind,
    exec: () => Promise.resolve(filas),
  };
  const cadenaFindOne = {
    exec: () => Promise.resolve(filas[0] ?? null),
  };

  return {
    filtros,
    escrituras,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return cadenaFind;
    }),
    findOne: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return cadenaFindOne;
    }),
    exists: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      // Distinguishes the name-collision check from the tipo-uniqueness
      // check by which key each filter carries, same as the two real cases.
      if ('name' in filtro) {
        return {
          exec: () =>
            Promise.resolve(opts.duplicadoNombre ? { _id: 'x' } : null),
        };
      }
      return {
        exec: () => Promise.resolve(opts.duplicadoTipo ? { _id: 'x' } : null),
      };
    }),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve(documento(doc));
    }),
    findOneAndUpdate: jest.fn(
      (_filtro: Filtro, update: Record<string, unknown>) => {
        escrituras.push((update as { $set: Record<string, unknown> }).$set);
        return { exec: () => Promise.resolve(filas[0] ? documento() : null) };
      },
    ),
  };
};

describe('ConceptosService.findAll', () => {
  it('filtra por la copropiedad del route param, ordenado por sortOrder', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.findAll(COP_ID);

    expect(modelo.filtros[0]).toEqual({
      coPropertyId: new Types.ObjectId(COP_ID),
    });
  });

  it('devuelve el contrato en español', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    const [concepto] = await service.findAll(COP_ID);

    expect(concepto).toEqual({
      id: CON_ID,
      copropiedadId: COP_ID,
      nombre: 'Administración',
      tipo: 'administracion',
      tasaImpuesto: 0,
      orden: 100,
      cuentaDebitoId: null,
      cuentaDebitoCodigo: null,
      cuentaCreditoId: null,
      cuentaCreditoCodigo: null,
      liquidaMora: false,
      cargaXls: false,
      sistema: false,
    });
  });

  it('extrae el código de cuenta solo cuando llega poblada', async () => {
    const cuentaPoblada = {
      _id: { toString: () => CUENTA_DEBITO_ID },
      code: '413501',
    };
    const modelo = modeloCon([documento({ cuentaDebitoId: cuentaPoblada })]);
    const service = new ConceptosService(modelo as never);

    const [concepto] = await service.findAll(COP_ID);

    expect(concepto.cuentaDebitoId).toBe(CUENTA_DEBITO_ID);
    expect(concepto.cuentaDebitoCodigo).toBe('413501');
  });
});

describe('ConceptosService.create', () => {
  it('rechaza un nombre repetido en la misma copropiedad', async () => {
    const modelo = modeloCon([], { duplicadoNombre: true });
    const service = new ConceptosService(modelo as never);

    await expect(
      service.create(COP_ID, { nombre: 'Administración' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza un segundo cargo de tipo "administracion" en la misma copropiedad', async () => {
    // El índice único parcial del schema exige lo mismo — este chequeo solo
    // convierte ese choque en un mensaje que un operador puede entender.
    const modelo = modeloCon([], { duplicadoTipo: true });
    const service = new ConceptosService(modelo as never);

    await expect(
      service.create(COP_ID, {
        nombre: 'Cuota extra',
        tipo: 'administracion',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('no exige unicidad de tipo para "otro": es la categoría libre', async () => {
    const modelo = modeloCon([], { duplicadoTipo: true });
    const service = new ConceptosService(modelo as never);

    await service.create(COP_ID, { nombre: 'Parqueadero', tipo: 'otro' });

    expect(modelo.escrituras[0]).toEqual({
      coPropertyId: new Types.ObjectId(COP_ID),
      sortOrder: 1,
      name: 'Parqueadero',
      kind: 'otro',
    });
  });

  it('crea con los campos traducidos al inglés, incluida la cuenta contable', async () => {
    const modelo = modeloCon([]);
    const service = new ConceptosService(modelo as never);

    await service.create(COP_ID, {
      nombre: 'Interés de mora',
      tipo: 'intereses',
      tasaImpuesto: 0,
      cuentaDebitoId: CUENTA_DEBITO_ID,
      cuentaCreditoId: CUENTA_CREDITO_ID,
      liquidaMora: true,
      cargaXls: true,
    });

    expect(modelo.escrituras[0]).toEqual({
      coPropertyId: new Types.ObjectId(COP_ID),
      sortOrder: 1,
      name: 'Interés de mora',
      kind: 'intereses',
      taxRate: 0,
      cuentaDebitoId: new Types.ObjectId(CUENTA_DEBITO_ID),
      cuentaCreditoId: new Types.ObjectId(CUENTA_CREDITO_ID),
      liquidaMora: true,
      availableAsNovedad: true,
    });
  });

  it('el orden se asigna automáticamente, uno más que el mayor existente', async () => {
    const modelo = modeloCon([documento({ sortOrder: 5 })]);
    const service = new ConceptosService(modelo as never);

    await service.create(COP_ID, { nombre: 'Parqueadero' });

    expect(modelo.escrituras[0]).toMatchObject({ sortOrder: 6 });
  });
});

describe('ConceptosService.update', () => {
  it('solo escribe los campos que vinieron en el patch', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.update(COP_ID, CON_ID, { tasaImpuesto: 19 });

    expect(modelo.escrituras[0]).toEqual({ taxRate: 19 });
  });

  it('no toca cuentaDebitoId/cuentaCreditoId cuando el patch no los menciona', async () => {
    // Antes esto los ponía en null igual, aunque el caller nunca los haya
    // enviado — un patch de "solo cambio el nombre" borraba las cuentas.
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.update(COP_ID, CON_ID, { nombre: 'Administración General' });

    expect(modelo.escrituras[0]).toEqual({ name: 'Administración General' });
  });

  it('limpia una cuenta cuando el patch la manda explícitamente vacía', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.update(COP_ID, CON_ID, { cuentaDebitoId: '' });

    expect(modelo.escrituras[0]).toEqual({ cuentaDebitoId: null });
  });

  it('actualiza liquidaMora y cargaXls', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.update(COP_ID, CON_ID, { liquidaMora: true, cargaXls: true });

    expect(modelo.escrituras[0]).toEqual({
      liquidaMora: true,
      availableAsNovedad: true,
    });
  });

  it('rechaza editar un cargo de sistema', async () => {
    const modelo = modeloCon([documento({ isSystem: true })]);
    const service = new ConceptosService(modelo as never);

    await expect(
      service.update(COP_ID, CON_ID, { tasaImpuesto: 19 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('no choca consigo mismo al guardar sin cambiar el tipo', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.update(COP_ID, CON_ID, { tipo: 'administracion' });

    expect(modelo.filtros[1]).toEqual({
      coPropertyId: new Types.ObjectId(COP_ID),
      kind: 'administracion',
      _id: { $ne: CON_ID },
    });
  });

  it('responde "no existe" cuando el id no corresponde a esta copropiedad', async () => {
    const modelo = modeloCon([]);
    const service = new ConceptosService(modelo as never);

    await expect(
      service.update(COP_ID, CON_ID, { tasaImpuesto: 5 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConceptosService } from './conceptos.service';

type Filtro = Record<string, unknown>;

const documento = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'con-1' },
  coPropertyId: { toString: () => 'cop-1' },
  name: 'Administración',
  kind: 'administracion',
  taxRate: 0,
  sortOrder: 100,
  active: true,
  ...over,
});

/** Chainable stub; records every filter and write it was called with. */
const modeloCon = (
  filas: unknown[],
  opts: { duplicadoNombre?: boolean; duplicadoTipo?: boolean } = {},
) => {
  const filtros: Filtro[] = [];
  const escrituras: Record<string, unknown>[] = [];
  const cadena = {
    sort: () => cadena,
    exec: () => Promise.resolve(filas),
  };

  return {
    filtros,
    escrituras,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return cadena;
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

    await service.findAll('cop-1');

    expect(modelo.filtros[0]).toEqual({ coPropertyId: 'cop-1' });
  });

  it('devuelve el contrato en español', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    const [concepto] = await service.findAll('cop-1');

    expect(concepto).toEqual({
      id: 'con-1',
      copropiedadId: 'cop-1',
      nombre: 'Administración',
      tipo: 'administracion',
      tasaImpuesto: 0,
      orden: 100,
      activo: true,
    });
  });
});

describe('ConceptosService.create', () => {
  it('rechaza un nombre repetido en la misma copropiedad', async () => {
    const modelo = modeloCon([], { duplicadoNombre: true });
    const service = new ConceptosService(modelo as never);

    await expect(
      service.create('cop-1', { nombre: 'Administración' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza un segundo cargo de tipo "administracion" en la misma copropiedad', async () => {
    // El índice único parcial del schema exige lo mismo — este chequeo solo
    // convierte ese choque en un mensaje que un operador puede entender.
    const modelo = modeloCon([], { duplicadoTipo: true });
    const service = new ConceptosService(modelo as never);

    await expect(
      service.create('cop-1', {
        nombre: 'Cuota extra',
        tipo: 'administracion',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('no exige unicidad de tipo para "otro": es la categoría libre', async () => {
    const modelo = modeloCon([], { duplicadoTipo: true });
    const service = new ConceptosService(modelo as never);

    await service.create('cop-1', { nombre: 'Parqueadero', tipo: 'otro' });

    expect(modelo.escrituras[0]).toEqual({
      coPropertyId: 'cop-1',
      name: 'Parqueadero',
      kind: 'otro',
    });
  });

  it('crea con los campos traducidos al inglés', async () => {
    const modelo = modeloCon([]);
    const service = new ConceptosService(modelo as never);

    await service.create('cop-1', {
      nombre: 'Interés de mora',
      tipo: 'intereses',
      tasaImpuesto: 0,
      orden: 50,
    });

    expect(modelo.escrituras[0]).toEqual({
      coPropertyId: 'cop-1',
      name: 'Interés de mora',
      kind: 'intereses',
      taxRate: 0,
      sortOrder: 50,
    });
  });

  it('guarda la cuenta contable de ingreso cuando viene', async () => {
    const modelo = modeloCon([]);
    const service = new ConceptosService(modelo as never);

    await service.create('cop-1', {
      nombre: 'Administración',
      cuentaContableIngreso: '413501',
    });

    expect(modelo.escrituras[0]).toMatchObject({
      accountingIncomeAccount: '413501',
    });
  });
});

describe('ConceptosService.update', () => {
  it('solo escribe los campos que vinieron en el patch', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.update('cop-1', 'con-1', { tasaImpuesto: 19 });

    expect(modelo.escrituras[0]).toEqual({ taxRate: 19 });
  });

  it('desactivar es una edición, no un borrado', async () => {
    // No hay endpoint de borrado: los documentos que ya usaron este cargo
    // tienen que seguir apuntando a algo legible.
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.update('cop-1', 'con-1', { activo: false });

    expect(modelo.escrituras[0]).toEqual({ active: false });
  });

  it('no choca consigo mismo al guardar sin cambiar el tipo', async () => {
    const modelo = modeloCon([documento()]);
    const service = new ConceptosService(modelo as never);

    await service.update('cop-1', 'con-1', { tipo: 'administracion' });

    expect(modelo.filtros[0]).toEqual({
      coPropertyId: 'cop-1',
      kind: 'administracion',
      _id: { $ne: 'con-1' },
    });
  });

  it('responde "no existe" cuando el id no corresponde a esta copropiedad', async () => {
    const modelo = modeloCon([]);
    const service = new ConceptosService(modelo as never);

    await expect(
      service.update('cop-1', 'con-ajeno', { tasaImpuesto: 5 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

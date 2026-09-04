import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ValoresRecurrentesService } from './valores-recurrentes.service';

type Filtro = Record<string, unknown>;

const COP = new Types.ObjectId();
const INMUEBLE_ID = new Types.ObjectId().toString();
const CONCEPTO_ADMIN = new Types.ObjectId();
const CONCEPTO_PARQUEADERO = new Types.ObjectId();

const tenantQueDevuelve = (cop: Types.ObjectId) =>
  ({ resolveCoPropertyId: () => cop }) as never;

const modeloInmuebles = (existe: boolean) => ({
  exists: jest.fn(() => ({
    exec: () => Promise.resolve(existe ? { _id: INMUEBLE_ID } : null),
  })),
});

const conceptoDoc = (over: Record<string, unknown> = {}) => ({
  _id: CONCEPTO_ADMIN,
  name: 'Administración',
  kind: 'administracion',
  sortOrder: 100,
  ...over,
});

const modeloConceptos = (conceptos: Record<string, unknown>[]) => ({
  find: jest.fn((filtro: Filtro) => ({
    sort: () => ({
      exec: () =>
        Promise.resolve(
          conceptos.filter(
            (c) => !filtro.kind || c.kind !== (filtro.kind as Filtro).$ne,
          ),
        ),
    }),
    filtro,
  })),
});

const modeloValoresRecurrentes = (
  filas: { conceptoId: Types.ObjectId; amount: number }[],
) => {
  const escrituras: Record<string, unknown>[] = [];
  const eliminados: Filtro[] = [];
  return {
    escrituras,
    eliminados,
    find: jest.fn(() => ({ exec: () => Promise.resolve(filas) })),
    findOneAndUpdate: jest.fn(
      (filtro: Filtro, update: Record<string, unknown>) => {
        escrituras.push({
          ...filtro,
          ...(update as { $set: Record<string, unknown> }).$set,
        });
        return { exec: () => Promise.resolve({}) };
      },
    ),
    deleteOne: jest.fn((filtro: Filtro) => {
      eliminados.push(filtro);
      return { exec: () => Promise.resolve({ deletedCount: 1 }) };
    }),
  };
};

const crearServicio = (opts: {
  inmuebleExiste?: boolean;
  conceptos?: Record<string, unknown>[];
  valores?: { conceptoId: Types.ObjectId; amount: number }[];
}) =>
  new ValoresRecurrentesService(
    modeloInmuebles(opts.inmuebleExiste ?? true) as never,
    modeloConceptos(opts.conceptos ?? [conceptoDoc()]) as never,
    modeloValoresRecurrentes(opts.valores ?? []) as never,
    tenantQueDevuelve(COP),
  );

describe('ValoresRecurrentesService.obtener', () => {
  it('rechaza un inmueble que no existe (o es de otra copropiedad)', async () => {
    const service = crearServicio({ inmuebleExiste: false });

    await expect(service.obtener(INMUEBLE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('devuelve un renglón por concepto, en monto 0 cuando no hay fila guardada', async () => {
    const service = crearServicio({
      conceptos: [
        conceptoDoc(),
        conceptoDoc({
          _id: CONCEPTO_PARQUEADERO,
          name: 'Cuota Parqueadero',
          kind: 'otro',
        }),
      ],
      valores: [],
    });

    const resultado = await service.obtener(INMUEBLE_ID);

    expect(resultado).toEqual([
      {
        conceptoId: CONCEPTO_ADMIN.toString(),
        conceptoNombre: 'Administración',
        monto: 0,
      },
      {
        conceptoId: CONCEPTO_PARQUEADERO.toString(),
        conceptoNombre: 'Cuota Parqueadero',
        monto: 0,
      },
    ]);
  });

  it('usa el monto guardado cuando existe una fila para el par inmueble+concepto', async () => {
    const service = crearServicio({
      valores: [{ conceptoId: CONCEPTO_ADMIN, amount: 350000 }],
    });

    const resultado = await service.obtener(INMUEBLE_ID);

    expect(resultado[0]).toMatchObject({ monto: 350000 });
  });

  it('excluye el concepto de tipo intereses — se calcula, nunca es un monto fijo', async () => {
    const conceptos = modeloConceptos([
      conceptoDoc(),
      conceptoDoc({
        _id: new Types.ObjectId(),
        name: 'Intereses',
        kind: 'intereses',
      }),
    ]);
    const service = new ValoresRecurrentesService(
      modeloInmuebles(true) as never,
      conceptos as never,
      modeloValoresRecurrentes([]) as never,
      tenantQueDevuelve(COP),
    );

    const resultado = await service.obtener(INMUEBLE_ID);

    expect(resultado.map((r) => r.conceptoNombre)).toEqual(['Administración']);
  });
});

describe('ValoresRecurrentesService.guardar', () => {
  it('rechaza un inmueble que no existe', async () => {
    const service = crearServicio({ inmuebleExiste: false });

    await expect(
      service.guardar(INMUEBLE_ID, {
        valores: [{ conceptoId: CONCEPTO_ADMIN.toString(), monto: 100 }],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un monto positivo hace upsert de la fila', async () => {
    const valoresRecurrentes = modeloValoresRecurrentes([]);
    const service = new ValoresRecurrentesService(
      modeloInmuebles(true) as never,
      modeloConceptos([conceptoDoc()]) as never,
      valoresRecurrentes as never,
      tenantQueDevuelve(COP),
    );

    await service.guardar(INMUEBLE_ID, {
      valores: [{ conceptoId: CONCEPTO_ADMIN.toString(), monto: 350000 }],
    });

    expect(valoresRecurrentes.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(valoresRecurrentes.escrituras[0]).toMatchObject({ amount: 350000 });
    expect(valoresRecurrentes.deleteOne).not.toHaveBeenCalled();
  });

  it('un monto de 0 borra la fila en vez de guardar un cero', async () => {
    const valoresRecurrentes = modeloValoresRecurrentes([
      { conceptoId: CONCEPTO_ADMIN, amount: 350000 },
    ]);
    const service = new ValoresRecurrentesService(
      modeloInmuebles(true) as never,
      modeloConceptos([conceptoDoc()]) as never,
      valoresRecurrentes as never,
      tenantQueDevuelve(COP),
    );

    await service.guardar(INMUEBLE_ID, {
      valores: [{ conceptoId: CONCEPTO_ADMIN.toString(), monto: 0 }],
    });

    expect(valoresRecurrentes.deleteOne).toHaveBeenCalledTimes(1);
    expect(valoresRecurrentes.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('devuelve la lista refrescada después de guardar', async () => {
    const service = crearServicio({
      valores: [{ conceptoId: CONCEPTO_ADMIN, amount: 999 }],
    });

    const resultado = await service.guardar(INMUEBLE_ID, {
      valores: [{ conceptoId: CONCEPTO_ADMIN.toString(), monto: 999 }],
    });

    expect(resultado[0]).toMatchObject({ monto: 999 });
  });
});

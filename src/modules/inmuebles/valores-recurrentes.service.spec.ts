import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ValoresRecurrentesService } from './valores-recurrentes.service';

type Filtro = Record<string, unknown>;

const COP = new Types.ObjectId();
const INMUEBLE_ID = new Types.ObjectId().toString();
const CONCEPTO_ADMIN = new Types.ObjectId();
const CONCEPTO_PARQUEADERO = new Types.ObjectId();
const CONCEPTO_INTERESES = new Types.ObjectId();

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

/** `find` returns every concept passed in (unfiltered — `obtener` no longer
 *  excludes `intereses` at the query level); `findOne` mimics the
 *  `{ kind: 'intereses' }` lookup `guardar` uses to find that one concept. */
const modeloConceptos = (conceptos: Record<string, unknown>[]) => ({
  find: jest.fn(() => ({
    sort: () => ({ exec: () => Promise.resolve(conceptos) }),
  })),
  findOne: jest.fn((filtro: Filtro) => ({
    exec: () =>
      Promise.resolve(conceptos.find((c) => c.kind === filtro.kind) ?? null),
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
    {} as never,
    modeloConceptos(opts.conceptos ?? [conceptoDoc()]) as never,
    modeloValoresRecurrentes(opts.valores ?? []) as never,
    tenantQueDevuelve(COP),
    {} as never,
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
        tipoConcepto: 'administracion',
        monto: 0,
      },
      {
        conceptoId: CONCEPTO_PARQUEADERO.toString(),
        conceptoNombre: 'Cuota Parqueadero',
        tipoConcepto: 'otro',
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

  it('incluye el concepto de intereses, identificado por tipoConcepto — para mostrarlo, no para guardarle un monto fijo', async () => {
    const service = crearServicio({
      conceptos: [
        conceptoDoc(),
        conceptoDoc({
          _id: CONCEPTO_INTERESES,
          name: 'Intereses por mora',
          kind: 'intereses',
        }),
      ],
    });

    const resultado = await service.obtener(INMUEBLE_ID);

    expect(resultado.map((r) => r.conceptoNombre)).toEqual([
      'Administración',
      'Intereses por mora',
    ]);
    expect(
      resultado.find((r) => r.conceptoId === CONCEPTO_INTERESES.toString()),
    ).toMatchObject({ tipoConcepto: 'intereses', monto: 0 });
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
      {} as never,
      modeloConceptos([conceptoDoc()]) as never,
      valoresRecurrentes as never,
      tenantQueDevuelve(COP),
      {} as never,
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
      {} as never,
      modeloConceptos([conceptoDoc()]) as never,
      valoresRecurrentes as never,
      tenantQueDevuelve(COP),
      {} as never,
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

  it('rechaza un monto positivo contra el concepto de intereses: se calcula, no se guarda fijo', async () => {
    const valoresRecurrentes = modeloValoresRecurrentes([]);
    const service = new ValoresRecurrentesService(
      modeloInmuebles(true) as never,
      {} as never,
      modeloConceptos([
        conceptoDoc(),
        conceptoDoc({
          _id: CONCEPTO_INTERESES,
          name: 'Intereses por mora',
          kind: 'intereses',
        }),
      ]) as never,
      valoresRecurrentes as never,
      tenantQueDevuelve(COP),
      {} as never,
    );

    await expect(
      service.guardar(INMUEBLE_ID, {
        valores: [
          { conceptoId: CONCEPTO_ADMIN.toString(), monto: 350000 },
          { conceptoId: CONCEPTO_INTERESES.toString(), monto: 50000 },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(valoresRecurrentes.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('acepta un monto de 0 para el concepto de intereses (equivale a no guardar nada)', async () => {
    const valoresRecurrentes = modeloValoresRecurrentes([]);
    const service = new ValoresRecurrentesService(
      modeloInmuebles(true) as never,
      {} as never,
      modeloConceptos([
        conceptoDoc(),
        conceptoDoc({
          _id: CONCEPTO_INTERESES,
          name: 'Intereses por mora',
          kind: 'intereses',
        }),
      ]) as never,
      valoresRecurrentes as never,
      tenantQueDevuelve(COP),
      {} as never,
    );

    await service.guardar(INMUEBLE_ID, {
      valores: [{ conceptoId: CONCEPTO_INTERESES.toString(), monto: 0 }],
    });

    expect(valoresRecurrentes.deleteOne).toHaveBeenCalledTimes(1);
  });
});

describe('ValoresRecurrentesService.importarMasivo', () => {
  const modeloInmueblesPorCodigo = (codigosExistentes: string[]) => ({
    findOne: jest.fn(({ code }: Filtro) => ({
      exec: () =>
        Promise.resolve(
          codigosExistentes.includes(code as string)
            ? { _id: { toString: () => INMUEBLE_ID } }
            : null,
        ),
    })),
    // `guardar` (called per matched row) resolves the unit a second time via
    // `exigirInmueble`'s own `exists` check — always true here, since this
    // suite only cares about the `codigoCopropiedad` row failing before
    // `guardar` is ever reached.
    exists: jest.fn(() => ({ exec: () => Promise.resolve({ _id: 'x' }) })),
  });

  const progresoModeloCon = () => ({
    intervalo: jest.fn(() => 1),
    iniciar: jest.fn().mockResolvedValue(undefined),
    actualizar: jest.fn().mockResolvedValue(undefined),
    finalizar: jest.fn().mockResolvedValue(undefined),
  });

  const copropiedadModeloCon = (code: string) => ({
    findById: jest.fn(() => ({ exec: () => Promise.resolve({ code }) })),
  });

  it('una fila con código de copropiedad que no coincide falla sola, el resto sigue', async () => {
    // A diferencia de InmueblesService.importar (que borra el listado antes
    // de escribir), este import nunca crea ni borra un inmueble — así que un
    // código equivocado puede fallar fila por fila, sin necesidad de
    // abortar el archivo entero primero.
    const valoresRecurrentes = modeloValoresRecurrentes([]);
    const service = new ValoresRecurrentesService(
      modeloInmueblesPorCodigo(['301', '302']) as never,
      copropiedadModeloCon('0001') as never,
      modeloConceptos([conceptoDoc()]) as never,
      valoresRecurrentes as never,
      tenantQueDevuelve(COP),
      progresoModeloCon() as never,
    );

    const resultado = await service.importarMasivo({
      filas: [
        {
          codigo: '301',
          codigoCopropiedad: '0001',
          valores: [{ conceptoId: CONCEPTO_ADMIN.toString(), monto: 350000 }],
        },
        {
          codigo: '302',
          codigoCopropiedad: 'OTRA',
          valores: [{ conceptoId: CONCEPTO_ADMIN.toString(), monto: 100000 }],
        },
      ],
    });

    expect(resultado.actualizados).toBe(1);
    expect(resultado.errores).toEqual([
      {
        fila: 2,
        codigo: '302',
        mensaje:
          'El código de copropiedad "OTRA" no coincide con el de la copropiedad activa (0001)',
      },
    ]);
  });
});

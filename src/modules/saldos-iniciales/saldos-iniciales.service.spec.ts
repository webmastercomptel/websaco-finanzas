import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { SaldosInicialesService } from './saldos-iniciales.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { ProgresoImportacionService } from '../inmuebles/progreso-importacion.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const CONCEPTO = new Types.ObjectId();
const CUENTA = new Types.ObjectId().toString();

const sesionFalsa = () => ({
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(() => Promise.resolve(undefined)),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(() => Promise.resolve(session)) }) as never;

const progresoFalso = (): ProgresoImportacionService =>
  ({
    intervalo: jest.fn(() => 1),
    iniciar: jest.fn(() => Promise.resolve(undefined)),
    actualizar: jest.fn(() => Promise.resolve(undefined)),
    finalizar: jest.fn(() => Promise.resolve(undefined)),
    obtener: jest.fn(() => Promise.resolve(null)),
  }) as unknown as ProgresoImportacionService;

/**
 * Same "shared-state, not one-shot stubs" discipline as
 * `saldos-iniciales-anticipo.service.spec.ts` — `listar`/`anular` both need
 * to see what `importar` wrote, and the three shared cartera ledgers must
 * actually accumulate across rows for the ledger-side assertions to mean
 * anything.
 */
const construirServicio = () => {
  const documentos: Record<string, unknown>[] = [];
  const saldosTotales: Record<string, unknown>[] = [];
  const carteraPorDocumentoFilas: Record<string, unknown>[] = [];
  const saldosCarteraFilas: Record<string, unknown>[] = [];

  const saldosIniciales = {
    create: jest.fn((filas: Record<string, unknown>[]) => {
      const creados = filas.map((f) => ({ _id: new Types.ObjectId(), ...f }));
      documentos.push(...creados);
      return Promise.resolve(creados);
    }),
    find: jest.fn(() => ({
      sort: jest.fn().mockReturnThis(),
      exec: () => Promise.resolve(documentos),
    })),
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      session: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve(
          documentos.find((d) => String(d._id) === String(filtro._id)) ?? null,
        ),
    })),
    updateOne: jest.fn(
      (
        filtro: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          const doc = documentos.find(
            (d) => String(d._id) === String(filtro._id),
          );
          if (doc) Object.assign(doc, update.$set);
          return Promise.resolve(doc ?? null);
        },
      }),
    ),
    countDocuments: jest.fn((filtro: Record<string, unknown>) => ({
      exec: () =>
        Promise.resolve(
          documentos.filter((d) =>
            filtro.status ? d.status === filtro.status : true,
          ).length,
        ),
    })),
  };

  const saldoTotalDocumento = {
    create: jest.fn((filas: Record<string, unknown>[]) => {
      const creados = filas.map((f) => ({ ...f }));
      saldosTotales.push(...creados);
      return Promise.resolve(creados);
    }),
    find: jest.fn((filtro: { documentoId?: { $in: unknown[] } }) => ({
      exec: () => {
        const ids = (filtro.documentoId?.$in ?? []).map(String);
        return Promise.resolve(
          saldosTotales.filter((s) => ids.includes(String(s.documentoId))),
        );
      },
    })),
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      session: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve(
          saldosTotales.find(
            (s) => String(s.documentoId) === String(filtro.documentoId),
          ) ?? null,
        ),
    })),
    updateOne: jest.fn(
      (
        filtro: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          const fila = saldosTotales.find(
            (s) => String(s.documentoId) === String(filtro.documentoId),
          );
          if (fila) Object.assign(fila, update.$set);
          return Promise.resolve(fila ?? null);
        },
      }),
    ),
  };

  const carteraPorDocumento = {
    create: jest.fn((filas: Record<string, unknown>[]) => {
      const creados = filas.map((f) => ({ _id: new Types.ObjectId(), ...f }));
      carteraPorDocumentoFilas.push(...creados);
      return Promise.resolve(creados);
    }),
    find: jest.fn((filtro: { documentoId?: unknown }) => ({
      session: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve(
          carteraPorDocumentoFilas.filter(
            (f) => String(f.documentoId) === String(filtro.documentoId),
          ),
        ),
    })),
    updateOne: jest.fn(
      (
        filtro: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          const fila = carteraPorDocumentoFilas.find(
            (f) => String(f._id) === String(filtro._id),
          );
          if (fila) Object.assign(fila, update.$set);
          return Promise.resolve(fila ?? null);
        },
      }),
    ),
  };

  const saldosCartera = {
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      session: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve(
          saldosCarteraFilas.find(
            (s) =>
              String(s.inmuebleId) === String(filtro.inmuebleId) &&
              String(s.conceptoId) === String(filtro.conceptoId),
          ) ?? null,
        ),
    })),
    findOneAndUpdate: jest.fn(
      (
        filtro: { inmuebleId: unknown; conceptoId: unknown },
        update: { $inc: Record<string, number> },
      ) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          let fila = saldosCarteraFilas.find(
            (s) =>
              String(s.inmuebleId) === String(filtro.inmuebleId) &&
              String(s.conceptoId) === String(filtro.conceptoId),
          );
          if (!fila) {
            fila = {
              inmuebleId: filtro.inmuebleId,
              conceptoId: filtro.conceptoId,
              balance: 0,
            };
            saldosCarteraFilas.push(fila);
          }
          fila.balance = (fila.balance as number) + (update.$inc.balance ?? 0);
          return Promise.resolve(fila);
        },
      }),
    ),
  };

  const lotes = {
    create: jest.fn((filas: Record<string, unknown>[]) =>
      Promise.resolve(filas.map((f) => ({ _id: new Types.ObjectId(), ...f }))),
    ),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };

  let nextNumber = 0;
  const consecutivos = {
    findOneAndUpdate: jest.fn(() => ({
      exec: () => {
        nextNumber += 1;
        return Promise.resolve({ nextNumber });
      },
    })),
  };

  const copropiedades = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ code: '0001' }),
    })),
  };

  const inmuebles = {
    find: jest.fn(() => ({
      exec: () => Promise.resolve([{ _id: INMUEBLE, code: 'AP-101' }]),
    })),
    findOne: jest.fn(() => ({
      session: jest.fn().mockReturnThis(),
      exec: () => Promise.resolve({ _id: INMUEBLE, code: 'AP-101' }),
    })),
  };

  const conceptosCobro = {
    find: jest.fn(() => ({
      populate: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve([
          {
            _id: CONCEPTO,
            name: 'Administración',
            kind: 'administracion',
            cuentaDebitoId: null,
            cuentaCreditoId: null,
          },
        ]),
    })),
  };

  const session = sesionFalsa();
  const service = new SaldosInicialesService(
    saldosIniciales as never,
    lotes as never,
    consecutivos as never,
    copropiedades as never,
    inmuebles as never,
    conceptosCobro as never,
    saldosCartera as never,
    carteraPorDocumento as never,
    saldoTotalDocumento as never,
    { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
    progresoFalso(),
    conexionCon(session),
  );

  return {
    service,
    documentos,
    saldosTotales,
    carteraPorDocumentoFilas,
    saldosCarteraFilas,
  };
};

const filaValida = (over: Record<string, unknown> = {}) => ({
  codigoCopropiedad: '0001',
  codigoInmueble: 'AP-101',
  tipoDocumento: 'FV',
  numero: '1001',
  fecha: '2026-01-01',
  fechaVencimiento: '2026-02-01',
  cargos: [{ conceptoId: CONCEPTO.toString(), monto: 300000 }],
  ...over,
});

const dtoValido = (
  filas: ReturnType<typeof filaValida>[],
  over: Record<string, unknown> = {},
) => ({
  filas,
  fechaCorte: '2026-01-31',
  valorTotal: filas.reduce(
    (sum, f) =>
      sum + (f.cargos as { monto: number }[]).reduce((s, c) => s + c.monto, 0),
    0,
  ),
  ...over,
});

describe('SaldosInicialesService.importar', () => {
  it('crea el documento y actualiza las tres tablas de cartera compartidas', async () => {
    const {
      service,
      documentos,
      saldosTotales,
      carteraPorDocumentoFilas,
      saldosCarteraFilas,
    } = construirServicio();

    const resultado = await service.importar(CUENTA, dtoValido([filaValida()]));

    expect(resultado.importados).toBe(1);
    expect(resultado.errores).toHaveLength(0);
    expect(documentos).toHaveLength(1);
    expect(saldosTotales).toHaveLength(1);
    expect(saldosTotales[0]).toMatchObject({
      total: 300000,
      saldoPendiente: 300000,
    });
    expect(carteraPorDocumentoFilas).toHaveLength(1);
    expect(saldosCarteraFilas[0]).toMatchObject({ balance: 300000 });
  });

  it('rechaza el archivo completo sin persistir nada si un inmueble no existe', async () => {
    const { service, documentos } = construirServicio();

    const resultado = await service.importar(
      CUENTA,
      dtoValido([
        filaValida(),
        filaValida({ codigoInmueble: 'NO-EXISTE', numero: '1002' }),
      ]),
    );

    expect(resultado.importados).toBe(0);
    expect(resultado.errores.length).toBeGreaterThan(0);
    expect(documentos).toHaveLength(0);
  });

  it('rechaza el archivo completo si una fecha es posterior a la fecha de corte', async () => {
    const { service, documentos } = construirServicio();

    const resultado = await service.importar(
      CUENTA,
      dtoValido([filaValida({ fecha: '2026-02-15' })], {
        fechaCorte: '2026-01-31',
      }),
    );

    expect(resultado.importados).toBe(0);
    expect(documentos).toHaveLength(0);
  });

  it('rechaza el archivo completo si el total no coincide con la suma de las filas', async () => {
    const { service, documentos } = construirServicio();

    const resultado = await service.importar(
      CUENTA,
      dtoValido([filaValida()], { valorTotal: 999999 }),
    );

    expect(resultado.importados).toBe(0);
    expect(resultado.errores.some((e) => e.fila === 0)).toBe(true);
    expect(documentos).toHaveLength(0);
  });

  it('rechaza el archivo completo si dos filas repiten el mismo documento del mismo inmueble', async () => {
    const { service, documentos } = construirServicio();

    const resultado = await service.importar(
      CUENTA,
      dtoValido([filaValida(), filaValida()]),
    );

    expect(resultado.importados).toBe(0);
    expect(documentos).toHaveLength(0);
  });

  it('bloquea una segunda importación mientras existan saldos iniciales activos', async () => {
    const { service } = construirServicio();
    await service.importar(CUENTA, dtoValido([filaValida()]));

    await expect(
      service.importar(CUENTA, dtoValido([filaValida({ numero: '1002' })])),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('permite importar de nuevo una vez se anularon todos los activos', async () => {
    const { service } = construirServicio();
    await service.importar(CUENTA, dtoValido([filaValida()]));
    const [{ id }] = await service.listar();
    await service.anular(
      id,
      { motivo: 'duplicado', detalle: 'Archivo cargado con datos de prueba' },
      CUENTA,
    );

    const resultado = await service.importar(
      CUENTA,
      dtoValido([filaValida({ numero: '1002' })]),
    );

    expect(resultado.importados).toBe(1);
  });
});

describe('SaldosInicialesService.listar', () => {
  it('resuelve saldoPendiente desde SaldoTotalDocumento, nunca desde el documento en sí', async () => {
    const { service } = construirServicio();
    await service.importar(CUENTA, dtoValido([filaValida()]));

    const [item] = await service.listar();

    expect(item.saldoPendiente).toBe(300000);
    expect(item.total).toBe(300000);
    expect(item.inmuebleCodigo).toBe('AP-101');
  });
});

describe('SaldosInicialesService.anular', () => {
  it('pone en cero el saldo pendiente restante y marca el documento anulado', async () => {
    const { service } = construirServicio();
    await service.importar(CUENTA, dtoValido([filaValida()]));
    const [{ id }] = await service.listar();

    const anulado = await service.anular(
      id,
      { motivo: 'duplicado', detalle: 'Fila duplicada del mismo archivo' },
      CUENTA,
    );

    expect(anulado.estado).toBe('anulado');
    expect(anulado.saldoPendiente).toBe(0);
  });

  it('lanza NotFoundException si el documento no existe', async () => {
    const { service } = construirServicio();

    await expect(
      service.anular(
        new Types.ObjectId().toString(),
        {
          motivo: 'otro',
          detalle: 'Detalle de prueba con longitud suficiente',
        },
        CUENTA,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

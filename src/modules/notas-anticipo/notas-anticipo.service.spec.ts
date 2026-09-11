import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { NotasAnticipoService } from './notas-anticipo.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

const sesionFalsa = () => ({
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(() => Promise.resolve(undefined)),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(() => Promise.resolve(session)) }) as never;

const lotesFacturacionFalso = () =>
  ({
    exigirSinLoteAbierto: jest.fn(() => Promise.resolve(undefined)),
    obtenerUltimoConsolidado: jest.fn(() => Promise.resolve(null)),
  }) as never;

type ReciboFixture = {
  _id: Types.ObjectId;
  coPropertyId: Types.ObjectId;
  inmuebleId: Types.ObjectId;
  terceroId: Types.ObjectId;
  fullNumber: string;
  status: string;
  unappliedAmount: number;
  appliedAmount: number;
} & Record<string, unknown>;

type FacturaFixture = {
  _id: Types.ObjectId;
  coPropertyId: Types.ObjectId;
  inmuebleId: Types.ObjectId;
  status: string;
  outstandingBalance: number;
  total: number;
} & Record<string, unknown>;

type NotaAnticipoFixture = {
  _id: Types.ObjectId;
  coPropertyId: Types.ObjectId;
  inmuebleId: Types.ObjectId;
  terceroId: Types.ObjectId;
  reciboOrigenId: Types.ObjectId;
  fullNumber: string;
  status: string;
  appliedAmount: number;
} & Record<string, unknown>;

const reciboDoc = (over: Partial<ReciboFixture> = {}): ReciboFixture => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  terceroId: TERCERO,
  fullNumber: 'RC-1',
  status: 'activo',
  unappliedAmount: 300000,
  appliedAmount: 200000,
  ...over,
});

const facturaDoc = (over: Partial<FacturaFixture> = {}): FacturaFixture => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  status: 'emitida',
  outstandingBalance: 200000,
  total: 200000,
  dueDate: new Date('2026-06-30'),
  lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 200000 }],
  discountAmount: 0,
  discountDeadline: null,
  ...over,
});

/**
 * Same "shared-state, not one-shot stubs" discipline as
 * `RecibosService`'s own ciclo-de-vida spec: `crear` decrements the Recibo
 * and the Factura for real, and `anular` has to see those same mutated
 * objects to restore them correctly.
 */
const construirServicio = (
  opciones: {
    recibo?: ReciboFixture;
    facturas?: FacturaFixture[];
    notaAnticipo?: NotaAnticipoFixture;
  } = {},
) => {
  const session = sesionFalsa();
  const recibo = opciones.recibo ?? reciboDoc();
  const facturasState = opciones.facturas ?? [facturaDoc()];
  let notaCreada: Record<string, unknown> = opciones.notaAnticipo ?? {};
  const aplicacionesCreadas: Record<string, unknown>[] = [];

  const notasAnticipo = {
    create: jest.fn((filas: Record<string, unknown>[]) => {
      notaCreada = { _id: new Types.ObjectId(), ...filas[0] };
      return Promise.resolve([notaCreada]);
    }),
    findOne: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(notaCreada) }),
      exec: () => Promise.resolve(notaCreada),
    })),
    findOneAndUpdate: jest.fn(
      (
        _f: unknown,
        update: {
          $set?: Record<string, unknown>;
          $inc?: Record<string, number>;
        },
      ) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          if (update.$set) Object.assign(notaCreada, update.$set);
          for (const [campo, delta] of Object.entries(update.$inc ?? {})) {
            notaCreada[campo] = ((notaCreada[campo] as number) ?? 0) + delta;
          }
          return Promise.resolve(notaCreada);
        },
      }),
    ),
    find: jest.fn(() => ({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exec: () => Promise.resolve([notaCreada]),
    })),
    countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(1) })),
  };

  const aplicaciones = {
    create: jest.fn((filas: Record<string, unknown>[]) => {
      const creadas = filas.map((f) => ({ _id: new Types.ObjectId(), ...f }));
      aplicacionesCreadas.push(...creadas);
      return Promise.resolve(creadas);
    }),
    find: jest.fn(() => ({
      sort: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      exec: () =>
        Promise.resolve(
          aplicacionesCreadas.filter((a) => a.status === 'activa'),
        ),
    })),
    findOneAndUpdate: jest.fn(
      (
        filtro: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          const fila = aplicacionesCreadas.find(
            (a) => String(a._id) === String(filtro._id),
          );
          if (fila) Object.assign(fila, update.$set);
          return Promise.resolve(fila ?? null);
        },
      }),
    ),
  };

  const recibos = {
    findOne: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(recibo) }),
    })),
    findOneAndUpdate: jest.fn(
      (_f: unknown, update: { $inc?: Record<string, number> }) => ({
        session: jest.fn().mockReturnThis(),
        exec: () => {
          for (const [campo, delta] of Object.entries(update.$inc ?? {})) {
            recibo[campo] = ((recibo[campo] as number) ?? 0) + delta;
          }
          return Promise.resolve(recibo);
        },
      }),
    ),
  };

  const facturas = {
    find: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(facturasState) }),
    })),
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      session: () => ({
        exec: () =>
          Promise.resolve(
            (() => {
              const factura = facturasState.find(
                (f) => String(f._id) === String(filtro._id),
              );
              return factura ? { ...factura } : null;
            })(),
          ),
      }),
    })),
    // `actualizarRemanentesLinea` (cruce.util.ts) — no test here asserts on
    // `remainingAmount` itself, only that the call doesn't blow up.
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };

  // The atomic guard/restore now lives here, not on `facturas` itself — see
  // `SaldoTotalDocumento`'s own docblock. Reuses `facturasState`'s own
  // `outstandingBalance` field as the shared backing state (test fixture
  // convenience, not a real schema shape).
  const saldoTotalDocumento = {
    findOneAndUpdate: jest.fn(
      (
        filtro: Record<string, unknown>,
        update: { $inc?: { saldoPendiente: number } },
      ) => ({
        exec: () => {
          const factura = facturasState.find(
            (f) => String(f._id) === String(filtro.documentoId),
          );
          if (!factura) return Promise.resolve(null);
          if (filtro.$expr) {
            const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
            if (factura.outstandingBalance < monto) {
              return Promise.resolve(null);
            }
            factura.outstandingBalance = factura.outstandingBalance - monto;
          } else if (update.$inc) {
            factura.outstandingBalance =
              factura.outstandingBalance + update.$inc.saldoPendiente;
          }
          return Promise.resolve({
            documentoId: factura._id,
            saldoPendiente: factura.outstandingBalance,
          });
        },
      }),
    ),
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      session: () => ({
        exec: () => {
          const factura = facturasState.find(
            (f) => String(f._id) === String(filtro.documentoId),
          );
          return Promise.resolve(
            factura
              ? { documentoId: factura._id, saldoPendiente: factura.outstandingBalance }
              : null,
          );
        },
      }),
    })),
    // The FIFO candidate query — every row with a positive balance among
    // the requested ids.
    find: jest.fn((filtro: { documentoId?: { $in: unknown[] } }) => ({
      session: () => ({
        exec: () => {
          const ids = (filtro.documentoId?.$in ?? []).map(String);
          return Promise.resolve(
            facturasState
              .filter(
                (f) =>
                  ids.includes(String(f._id)) && f.outstandingBalance > 0,
              )
              .map((f) => ({
                documentoId: f._id,
                saldoPendiente: f.outstandingBalance,
              })),
          );
        },
      }),
    })),
  };

  const notasDebito = {
    find: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve([]) }),
    })),
    findOneAndUpdate: jest.fn(() => ({
      exec: () => Promise.resolve(null),
    })),
  };

  const saldos = {
    findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };
  const carteraPorDocumento = {
    findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  };
  const asientosStore: { entries: unknown[] }[] = [];
  const asientos = {
    create: jest.fn((filas: { entries: unknown[] }[]) => {
      asientosStore.push(...filas);
      return Promise.resolve(filas);
    }),
  };
  const copropiedades = {
    findById: jest.fn(() => ({
      session: () => ({
        exec: () =>
          Promise.resolve({
            receivablesAccount: '130501',
            advancesAccount: '210505',
          }),
      }),
    })),
  };
  const numeracion = {
    siguienteDocumento: jest.fn(() =>
      Promise.resolve({ prefijo: 'NA', numero: 1, completo: 'NA-1' }),
    ),
  };

  const service = new NotasAnticipoService(
    notasAnticipo as never,
    aplicaciones as never,
    recibos as never,
    facturas as never,
    notasDebito as never,
    saldos as never,
    carteraPorDocumento as never,
    saldoTotalDocumento as never,
    asientos as never,
    copropiedades as never,
    { resolveCoPropertyId: () => COP } as never,
    numeracion as never,
    conexionCon(session),
    lotesFacturacionFalso(),
  );

  return {
    service,
    recibo,
    facturasState,
    asientosStore,
    notasAnticipo,
    recibos,
  };
};

describe('NotasAnticipoService.crear', () => {
  it('rechaza cuando no se indica ni aplicaciones ni aplicacionAutomatica', async () => {
    const { service } = construirServicio();
    await expect(
      service.crear(CUENTA.toString(), {
        codigo: 'NA',
        reciboOrigenId: new Types.ObjectId().toString(),
        fechaEmision: '2026-09-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza cuando se indican ambas a la vez', async () => {
    const { service } = construirServicio();
    await expect(
      service.crear(CUENTA.toString(), {
        codigo: 'NA',
        reciboOrigenId: new Types.ObjectId().toString(),
        fechaEmision: '2026-09-01',
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: new Types.ObjectId().toString(),
            montoAplicado: 1000,
          },
        ],
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lanza NotFoundException si el recibo no existe o no está activo', async () => {
    const { service, recibos } = construirServicio();
    (recibos.findOne as jest.Mock).mockReturnValueOnce({
      session: () => ({ exec: () => Promise.resolve(null) }),
    });

    await expect(
      service.crear(CUENTA.toString(), {
        codigo: 'NA',
        reciboOrigenId: new Types.ObjectId().toString(),
        fechaEmision: '2026-09-01',
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza si el recibo no tiene anticipo pendiente', async () => {
    const { service } = construirServicio({
      recibo: reciboDoc({ unappliedAmount: 0 }),
    });

    await expect(
      service.crear(CUENTA.toString(), {
        codigo: 'NA',
        reciboOrigenId: new Types.ObjectId().toString(),
        fechaEmision: '2026-09-01',
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza si no hay cartera abierta contra la cual aplicar (FIFO no encuentra nada)', async () => {
    const { service } = construirServicio({ facturas: [] });

    await expect(
      service.crear(CUENTA.toString(), {
        codigo: 'NA',
        reciboOrigenId: new Types.ObjectId().toString(),
        fechaEmision: '2026-09-01',
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('aplica automáticamente (FIFO) contra la factura abierta, decrementando el recibo y postea un asiento anclado a notaAnticipoId', async () => {
    const { service, recibo, facturasState, asientosStore } =
      construirServicio();

    const resultado = await service.crear(CUENTA.toString(), {
      codigo: 'NA',
      reciboOrigenId: recibo._id.toString(),
      fechaEmision: '2026-09-01',
      aplicacionAutomatica: true,
    });

    expect(resultado.montoAplicado).toBe(200000);
    expect(recibo.unappliedAmount).toBe(100000);
    expect(recibo.appliedAmount).toBe(400000);
    expect(facturasState[0].outstandingBalance).toBe(0);

    expect(asientosStore).toHaveLength(1);
    const entries = asientosStore[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    // Un débito a anticipos por el TOTAL aplicado, un solo registro.
    const debitos = entries.filter((m) => m.type === 'debito');
    expect(debitos).toHaveLength(1);
    expect(debitos[0]).toMatchObject({ account: '210505', amount: 200000 });
    // Crédito directo a la cuenta de cartera de la factura.
    const creditos = entries.filter((m) => m.type === 'credito');
    expect(creditos.some((c) => c.amount === 200000)).toBe(true);
  });

  it('usa fechaEmision (no el instante real del servidor) como issueDate y como fecha del asiento', async () => {
    const { service, recibo, asientosStore, notasAnticipo } =
      construirServicio();

    const resultado = await service.crear(CUENTA.toString(), {
      codigo: 'NA',
      reciboOrigenId: recibo._id.toString(),
      fechaEmision: '2026-10-01',
      aplicacionAutomatica: true,
    });

    expect(resultado.fechaEmision).toBe('2026-10-01T00:00:00.000Z');
    const [filas] = notasAnticipo.create.mock.calls[0] as unknown as [
      { issueDate: Date }[],
    ];
    expect(filas[0].issueDate).toEqual(new Date('2026-10-01'));
    expect(asientosStore[0]).toMatchObject({ date: new Date('2026-10-01') });
  });

  it('aplica manualmente contra un documento específico', async () => {
    const { service, recibo, facturasState } = construirServicio();
    const facturaId = facturasState[0]._id;

    const resultado = await service.crear(CUENTA.toString(), {
      codigo: 'NA',
      reciboOrigenId: recibo._id.toString(),
      fechaEmision: '2026-09-01',
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 150000,
        },
      ],
    });

    expect(resultado.montoAplicado).toBe(150000);
    expect(recibo.unappliedAmount).toBe(150000);
    expect(facturasState[0].outstandingBalance).toBe(50000);
  });

  it('aplica manualmente con reparto por concepto elegido por el usuario', async () => {
    const conceptoAdmin = new Types.ObjectId();
    const conceptoIntereses = new Types.ObjectId();
    const factura = facturaDoc({
      total: 300000,
      outstandingBalance: 300000,
      lines: [
        { conceptoId: conceptoAdmin, totalAmount: 200000 },
        { conceptoId: conceptoIntereses, totalAmount: 100000 },
      ],
    });
    const { service, recibo } = construirServicio({
      recibo: reciboDoc({ unappliedAmount: 100000, appliedAmount: 0 }),
      facturas: [factura],
    });

    const resultado = await service.crear(CUENTA.toString(), {
      codigo: 'NA',
      reciboOrigenId: recibo._id.toString(),
      fechaEmision: '2026-09-01',
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: factura._id.toString(),
          montoAplicado: 100000,
          distribucion: [
            { conceptoId: conceptoIntereses.toString(), monto: 100000 },
          ],
        },
      ],
    });

    expect(resultado.montoAplicado).toBe(100000);
    // Intereses queda saldado, Administración sigue intacta.
    expect(factura.outstandingBalance).toBe(200000);
  });
});

describe('NotasAnticipoService.anular', () => {
  it('revierte la aplicación, restaura la factura y devuelve el monto al recibo de origen', async () => {
    const { service, recibo, facturasState, asientosStore } =
      construirServicio();

    const creada = await service.crear(CUENTA.toString(), {
      codigo: 'NA',
      reciboOrigenId: recibo._id.toString(),
      fechaEmision: '2026-09-01',
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturasState[0]._id.toString(),
          montoAplicado: 150000,
        },
      ],
    });
    expect(recibo.unappliedAmount).toBe(150000);
    expect(facturasState[0].outstandingBalance).toBe(50000);

    const anulada = await service.anular(
      creada.id,
      {
        motivo: 'error_digitacion',
        detalle: 'Se aplicó contra la factura equivocada por error',
        fecha: '2026-09-05',
      },
      CUENTA.toString(),
    );

    expect(anulada.estado).toBe('anulado');
    // El recibo recupera exactamente lo que esta nota había aplicado.
    expect(recibo.unappliedAmount).toBe(300000);
    expect(recibo.appliedAmount).toBe(200000);
    // La factura recupera su saldo.
    expect(facturasState[0].outstandingBalance).toBe(200000);
    // Dos asientos: creación y reversión.
    expect(asientosStore).toHaveLength(2);
  });

  it('lanza ConflictException si ya está anulada', async () => {
    const { service, recibo, facturasState } = construirServicio();
    const creada = await service.crear(CUENTA.toString(), {
      codigo: 'NA',
      reciboOrigenId: recibo._id.toString(),
      fechaEmision: '2026-09-01',
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturasState[0]._id.toString(),
          montoAplicado: 100000,
        },
      ],
    });

    await service.anular(
      creada.id,
      {
        motivo: 'otro',
        detalle: 'Detalle de prueba con longitud suficiente',
        fecha: '2026-09-05',
      },
      CUENTA.toString(),
    );

    await expect(
      service.anular(
        creada.id,
        {
          motivo: 'otro',
          detalle: 'Detalle de prueba con longitud suficiente',
          fecha: '2026-09-05',
        },
        CUENTA.toString(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

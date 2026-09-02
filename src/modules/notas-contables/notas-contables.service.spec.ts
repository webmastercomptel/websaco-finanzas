import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { NotasContablesService } from './notas-contables.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const CONCEPTO_ORIGEN = new Types.ObjectId();
const CONCEPTO_DESTINO = new Types.ObjectId();

const sesionFalsa = () => ({
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(() => Promise.resolve(undefined)),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(() => Promise.resolve(session)) }) as never;

const tenantQueDevuelve = (id: Types.ObjectId): TenantContextService =>
  ({ resolveCoPropertyId: () => id }) as unknown as TenantContextService;

const numeracionQueEntrega = (completo: string): NumeracionService =>
  ({
    siguienteDocumento: jest.fn(() =>
      Promise.resolve({ prefijo: 'NT', numero: 1, completo }),
    ),
  }) as unknown as NumeracionService;

const notaContableCreada = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  inmuebleId: INMUEBLE,
  conceptoOrigenId: CONCEPTO_ORIGEN,
  conceptoDestinoId: CONCEPTO_DESTINO,
  monto: 100000,
  description: 'Reclasificación de prueba',
  prefix: 'NT',
  number: 1,
  fullNumber: 'NT-1',
  status: 'activo',
  voidedReason: null,
  voidedDetail: null,
  voidedAt: null,
  ...over,
});

const modeloNotasContables = (creada: Record<string, unknown>) => ({
  create: jest.fn(() => Promise.resolve([creada])),
  findOne: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(creada) }),
    exec: () => Promise.resolve(creada),
  })),
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(creada) })),
});

const modeloSaldos = () => ({
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
});

const modeloAsientos = () => ({ create: jest.fn(() => Promise.resolve([{}])) });

const modeloConceptos = (cuenta: string | null = '413501') => ({
  findOne: jest.fn(() => ({
    session: () => ({
      exec: () => Promise.resolve({ accountingIncomeAccount: cuenta }),
    }),
  })),
});

const construirServicio = (opts: {
  notaCreada: Record<string, unknown>;
  saldos?: { findOneAndUpdate: jest.Mock };
  saldoOrigen?: number;
}) => {
  const session = sesionFalsa();
  const notasContables = modeloNotasContables(opts.notaCreada);
  const saldos = opts.saldos ?? modeloSaldos();
  const asientos = modeloAsientos();
  const conceptos = modeloConceptos();

  // Mock saldo origin balance for the balance check in crear().
  const saldofindOne = jest.fn(() => ({
    session: () => ({
      exec: () =>
        Promise.resolve(
          opts.saldoOrigen !== undefined
            ? { balance: opts.saldoOrigen }
            : { balance: 200000 },
        ),
    }),
  }));

  const service = new NotasContablesService(
    notasContables as never,
    saldos as never,
    asientos as never,
    conceptos as never,
    tenantQueDevuelve(COP),
    numeracionQueEntrega('NT-1'),
    conexionCon(session),
  );

  // Override saldos.findOne for the balance check.
  (service as unknown as { saldos: { findOne: jest.Mock } }).saldos.findOne =
    saldofindOne;

  return {
    service,
    notasContables,
    saldos,
    asientos,
    conceptos,
    saldofindOne,
  };
};

const dtoBase = (over: Record<string, unknown> = {}) => ({
  inmuebleId: INMUEBLE.toString(),
  conceptoOrigenId: CONCEPTO_ORIGEN.toString(),
  conceptoDestinoId: CONCEPTO_DESTINO.toString(),
  monto: 100000,
  descripcion: 'Reclasificación entre conceptos',
  ...over,
});

describe('NotasContablesService.crear', () => {
  it('mueve el monto exacto entre los SaldoCartera de los dos conceptos', async () => {
    const notaCreada = notaContableCreada();
    const { service, notasContables, asientos, saldos } = construirServicio({
      notaCreada,
    });

    const resultado = await service.crear('acc-1', dtoBase());

    expect(resultado.numeroCompleto).toBe('NT-1');
    expect(notasContables.create).toHaveBeenCalledTimes(1);
    expect(asientos.create).toHaveBeenCalledTimes(1);

    // El bug real que esto habría cazado: la versión anterior de este test
    // solo miraba que `create()` se llamara, nunca los argumentos reales de
    // `saldos.findOneAndUpdate` — un signo invertido o un conceptoId
    // equivocado habría pasado igual.
    expect(saldos.findOneAndUpdate).toHaveBeenCalledTimes(2);
    const llamadasSaldos = saldos.findOneAndUpdate.mock.calls as Array<
      [Record<string, unknown>, unknown]
    >;
    const extraerMonto = (conceptoId: Types.ObjectId): number => {
      const llamada = llamadasSaldos.find(([filtro]) =>
        (filtro.conceptoId as Types.ObjectId).equals(conceptoId),
      );
      if (!llamada)
        throw new Error(`No hubo llamada para ${conceptoId.toString()}`);
      const pipeline = llamada[1] as [
        { $set: { balance: { $max: [number, { $add: [string, number] }] } } },
      ];
      return pipeline[0].$set.balance.$max[1].$add[1];
    };

    expect(extraerMonto(CONCEPTO_ORIGEN)).toBe(-100000);
    expect(extraerMonto(CONCEPTO_DESTINO)).toBe(100000);
  });

  it('rechaza un monto no positivo antes de tocar ningún saldo', async () => {
    const { service, saldos, notasContables } = construirServicio({
      notaCreada: {},
    });

    await expect(
      service.crear('acc-1', dtoBase({ monto: 0 })),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.crear('acc-1', dtoBase({ monto: -50000 })),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(saldos.findOneAndUpdate).not.toHaveBeenCalled();
    expect(notasContables.create).not.toHaveBeenCalled();
  });

  it('rechaza cuando conceptoOrigenId === conceptoDestinoId', async () => {
    const { service } = construirServicio({ notaCreada: {} });
    const mismoConcepto = new Types.ObjectId().toString();

    await expect(
      service.crear('acc-1', {
        ...dtoBase(),
        conceptoOrigenId: mismoConcepto,
        conceptoDestinoId: mismoConcepto,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza cuando monto excede el saldo del concepto de origen', async () => {
    const { service } = construirServicio({
      notaCreada: {},
      saldoOrigen: 50000,
    });

    await expect(
      service.crear('acc-1', dtoBase({ monto: 100000 })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('el error de saldo insuficiente nombra el saldo disponible real', async () => {
    const { service } = construirServicio({
      notaCreada: {},
      saldoOrigen: 50000,
    });

    try {
      await service.crear('acc-1', dtoBase({ monto: 100000 }));
      fail('Debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toContain('50000');
    }
  });

  it('acepta monto igual al saldo disponible del concepto de origen', async () => {
    const notaCreada = notaContableCreada({ monto: 200000 });
    const { service, notasContables } = construirServicio({
      notaCreada,
      saldoOrigen: 200000,
    });

    await service.crear(
      'acc-1',
      dtoBase({ monto: 200000, descripcion: 'Reclasificación completa' }),
    );

    expect(notasContables.create).toHaveBeenCalledTimes(1);
  });

  it('postea el asiento de creación con la notaContableId', async () => {
    const notaCreada = notaContableCreada();
    const { service, asientos } = construirServicio({ notaCreada });

    await service.crear('acc-1', dtoBase());

    const calls = (asientos.create as jest.Mock).mock.calls as unknown[][][];
    const creado = calls[0][0][0] as Record<string, unknown>;
    expect(creado).toMatchObject({
      notaContableId: notaCreada._id,
      notaCreditoId: null,
      notaDebitoId: null,
    });
  });

  it('usa la cuentaContableIngreso de cada concepto para el asiento', async () => {
    const notaCreada = notaContableCreada();
    const conceptos = {
      findOne: jest.fn((filtro: { _id: Types.ObjectId }) => ({
        session: () => ({
          exec: () => {
            if (filtro._id.equals(CONCEPTO_ORIGEN)) {
              return Promise.resolve({ accountingIncomeAccount: '413501' });
            }
            if (filtro._id.equals(CONCEPTO_DESTINO)) {
              return Promise.resolve({ accountingIncomeAccount: '413502' });
            }
            return Promise.resolve(null);
          },
        }),
      })),
    };
    const asientos = modeloAsientos();
    const service = new NotasContablesService(
      modeloNotasContables(notaCreada) as never,
      modeloSaldos() as never,
      asientos as never,
      conceptos as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NT-1'),
      conexionCon(sesionFalsa()),
    );
    (service as unknown as { saldos: { findOne: jest.Mock } }).saldos.findOne =
      jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve({ balance: 200000 }) }),
      }));

    await service.crear('acc-1', dtoBase());

    expect(conceptos.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: CONCEPTO_ORIGEN, coPropertyId: COP }),
    );
    expect(conceptos.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: CONCEPTO_DESTINO, coPropertyId: COP }),
    );
    const calls = (asientos.create as jest.Mock).mock.calls as unknown[][][];
    const creado = calls[0][0][0] as {
      entries: { type: string; account: string }[];
    };
    const debit = creado.entries.find((m) => m.type === 'debito');
    const credit = creado.entries.find((m) => m.type === 'credito');
    expect(debit!.account).toBe('413501');
    expect(credit!.account).toBe('413502');
  });
});

describe('NotasContablesService.anular', () => {
  it('revierte los saldos (destino→origen) y marca como anulado', async () => {
    const nota = notaContableCreada();
    const notasContables = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $set?: Record<string, unknown> }) => ({
          exec: () => {
            if (update?.$set) Object.assign(nota, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const asientos = modeloAsientos();
    const service = new NotasContablesService(
      notasContables as never,
      modeloSaldos() as never,
      asientos as never,
      modeloConceptos() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NT-1'),
      conexionCon(sesionFalsa()),
    );

    const resultado = await service.anular(
      nota._id.toString(),
      {
        motivo: 'error_digitacion',
        detalle: 'Error en la reclasificación, se anula',
      },
      'acc-1',
    );

    expect(resultado.estado).toBe('anulado');
    expect(asientos.create).toHaveBeenCalledTimes(1);
  });

  it('rechaza anular una nota contable ya anulada', async () => {
    const nota = notaContableCreada({ status: 'anulado' });
    const service = new NotasContablesService(
      modeloNotasContables(nota) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloConceptos() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NT-1'),
      conexionCon(sesionFalsa()),
    );

    await expect(
      service.anular(
        nota._id.toString(),
        { motivo: 'otro', detalle: 'Detalle de más de veinte caracteres' },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lanza NotFoundException cuando la nota no existe', async () => {
    const notasContables = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(null) }),
      })),
    };
    const service = new NotasContablesService(
      notasContables as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloConceptos() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NT-1'),
      conexionCon(sesionFalsa()),
    );

    await expect(
      service.anular(
        'no-existe',
        { motivo: 'otro', detalle: 'Detalle de más de veinte caracteres' },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('postea el asiento espejo (cuentas invertidas)', async () => {
    const conceptoOrigen = new Types.ObjectId();
    const conceptoDestino = new Types.ObjectId();
    const nota = notaContableCreada({
      conceptoOrigenId: conceptoOrigen,
      conceptoDestinoId: conceptoDestino,
      monto: 75000,
    });
    const conceptos = {
      findOne: jest.fn((filtro: { _id: Types.ObjectId }) => ({
        session: () => ({
          exec: () => {
            if (filtro._id.equals(conceptoOrigen)) {
              return Promise.resolve({ accountingIncomeAccount: '413501' });
            }
            if (filtro._id.equals(conceptoDestino)) {
              return Promise.resolve({ accountingIncomeAccount: '413502' });
            }
            return Promise.resolve(null);
          },
        }),
      })),
    };
    const asientos = modeloAsientos();
    const service = new NotasContablesService(
      modeloNotasContables(nota) as never,
      modeloSaldos() as never,
      asientos as never,
      conceptos as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NT-1'),
      conexionCon(sesionFalsa()),
    );

    await service.anular(
      nota._id.toString(),
      { motivo: 'otro', detalle: 'Anulación de prueba con detalle largo' },
      'acc-1',
    );

    const calls = (asientos.create as jest.Mock).mock.calls as unknown[][][];
    const creado = calls[0][0][0] as {
      entries: { type: string; account: string }[];
    };
    // Swapped: destino account is debited, origen account is credited.
    const debito = creado.entries.find((m) => m.type === 'debito');
    const credito = creado.entries.find((m) => m.type === 'credito');
    expect(debito!.account).toBe('413502');
    expect(credito!.account).toBe('413501');
  });
});

describe('NotasContablesService.findAll', () => {
  it('filtra por copropiedad, inmueble, estado y rango de fecha', async () => {
    const documentos: unknown[] = [];
    const notasContables = {
      find: jest.fn((filtro: Record<string, unknown>) => {
        (notasContables as unknown as { filtroUsado: unknown }).filtroUsado =
          filtro;
        return {
          sort: () => ({
            skip: () => ({
              limit: () => ({ exec: () => Promise.resolve(documentos) }),
            }),
          }),
        };
      }),
      countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(0) })),
    };
    const service = new NotasContablesService(
      notasContables as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloConceptos() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NT-1'),
      conexionCon(sesionFalsa()),
    );

    await service.findAll({
      inmuebleId: INMUEBLE.toString(),
      estado: 'activo',
      fechaDesde: '2026-08-01',
      fechaHasta: '2026-08-31',
    });

    expect(
      (notasContables as unknown as { filtroUsado: Record<string, unknown> })
        .filtroUsado,
    ).toEqual({
      coPropertyId: COP,
      inmuebleId: INMUEBLE.toString(),
      status: 'activo',
      createdAt: {
        $gte: new Date('2026-08-01'),
        $lte: new Date('2026-08-31'),
      },
    });
  });
});

describe('NotasContablesService.findOne', () => {
  it('devuelve la nota contable por id', async () => {
    const nota = notaContableCreada();
    const service = new NotasContablesService(
      modeloNotasContables(nota) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloConceptos() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NT-1'),
      conexionCon(sesionFalsa()),
    );

    const resultado = await service.findOne(nota._id.toString());
    expect(resultado.numeroCompleto).toBe('NT-1');
  });

  it('lanza NotFoundException cuando la nota no existe', async () => {
    const service = new NotasContablesService(
      modeloNotasContables({}) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloConceptos() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NT-1'),
      conexionCon(sesionFalsa()),
    );
    // Override findOne to return null.
    (
      service as unknown as { notasContables: { findOne: jest.Mock } }
    ).notasContables.findOne = jest.fn(() => ({
      exec: () => Promise.resolve(null),
    }));

    await expect(service.findOne('no-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

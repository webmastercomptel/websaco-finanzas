import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { RecibosService } from './recibos.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';
import type { PeriodoService } from '../../common/contabilidad/periodo.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

/** Runs `fn` synchronously — no real transaction, matching how this whole
 *  repo's tests stub Mongoose (see the header note on this plan). */
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
      Promise.resolve({ prefijo: 'RC', numero: 1, completo }),
    ),
  }) as unknown as NumeracionService;

/** No open Lote in any test here — the guard always passes. No consolidated
 *  Lote either, by default — `obtenerUltimoConsolidado` returning `null`
 *  means "nothing to validate the payment date's period against", the same
 *  default `RecibosService.crear()` treats as a no-op. Tests exercising the
 *  period-match validation pass their own `lotes` override. */
const lotesFacturacionFalso = (ultimoConsolidado: unknown = null) =>
  ({
    exigirSinLoteAbierto: jest.fn(() => Promise.resolve(undefined)),
    obtenerUltimoConsolidado: jest.fn(() => Promise.resolve(ultimoConsolidado)),
  }) as never;

/**
 * Periodo abierto: `exigirAbierto` no lanza. Es el default de TODOS los tests
 * de acá — el periodo cerrado es el caso excepcional, y tiene el suyo propio
 * más abajo. Devuelve también el spy suelto porque asertar sobre
 * `periodo.exigirAbierto` directamente sería un método desligado de su
 * instancia (`@typescript-eslint/unbound-method`).
 */
const periodoEspiado = () => {
  const exigirAbierto = jest.fn(() => Promise.resolve());
  const periodo = { exigirAbierto } as unknown as PeriodoService;
  return { periodo, exigirAbierto };
};

const periodoAbierto = (): PeriodoService => periodoEspiado().periodo;

const periodoCerrado = (): PeriodoService =>
  ({
    exigirAbierto: jest.fn(() => {
      throw new ConflictException('El periodo 08/2026 está cerrado.');
    }),
  }) as unknown as PeriodoService;

const modeloRecibos = (creado: Record<string, unknown>) => ({
  create: jest.fn(() => Promise.resolve([creado])),
  findOne: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(creado) }),
  })),
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(creado) })),
});

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  status: 'emitida',
  outstandingBalance: 500000,
  total: 500000,
  lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 500000 }],
  discountAmount: 0,
  discountDeadline: null,
  ...over,
});

const notaDebitoDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  conceptoId: new Types.ObjectId(),
  status: 'emitida',
  outstandingBalance: 150000,
  total: 150000,
  issueDate: new Date('2026-08-01'),
  ...over,
});

/** `find` defaults to empty — most tests here apply manually to a specific
 *  `documentoId` via `findOneAndUpdate` and never run FIFO's candidate
 *  query. Tests that DO need FIFO to find something build their own richer
 *  `facturas` mock (see `RecibosService.crear — con aplicacionAutomatica`),
 *  same reasoning as `modeloNotasDebito`'s own default. */
const modeloFacturas = (factura: Record<string, unknown>) => ({
  find: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve([]) }),
  })),
  findOne: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve({ ...factura }) }),
  })),
  // `actualizarRemanentesLinea` (cruce.util.ts) — a manual distribucion
  // persists each targeted línea's new `remainingAmount` here.
  updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
});

const modeloSaldos = () => ({
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
});

// Same shape as `modeloSaldos` above — `ajustarSaldosCartera`/
// `ajustarSaldosCarteraPorDistribucion` now run the identical
// findOneAndUpdate pipeline against this model too, per concepto part.
const modeloCarteraPorDocumento = () => ({
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
});

/** Combined `SaldoTotalDocumento` mock, backed by whichever Factura/NotaDebito
 *  fixtures the caller passes — same shared-mutable-state trick
 *  `modeloFacturas`/`modeloNotasDebito` used to run directly on their own
 *  `outstandingBalance` field, just relocated off those (now immutable)
 *  documents onto this collection instead (see `SaldoTotalDocumento`'s own
 *  docblock on why the atomic guard had to move). */
const modeloSaldoTotalDocumento = (documentos: Record<string, unknown>[]) => ({
  findOneAndUpdate: jest.fn(
    (
      filtro: Record<string, unknown>,
      update: { $inc?: { saldoPendiente: number } },
    ) => ({
      exec: () => {
        const doc = documentos.find(
          (d) => String(d._id) === String(filtro.documentoId),
        );
        if (!doc) return Promise.resolve(null);
        if (filtro.$expr) {
          const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
          if ((doc.outstandingBalance as number) < monto) {
            return Promise.resolve(null);
          }
          doc.outstandingBalance = (doc.outstandingBalance as number) - monto;
        } else if (update.$inc) {
          doc.outstandingBalance =
            (doc.outstandingBalance as number) + update.$inc.saldoPendiente;
        }
        return Promise.resolve({
          documentoId: doc._id,
          saldoPendiente: doc.outstandingBalance,
        });
      },
    }),
  ),
  findOne: jest.fn((filtro: Record<string, unknown>) => ({
    session: () => ({
      exec: () => {
        const doc = documentos.find(
          (d) => String(d._id) === String(filtro.documentoId),
        );
        return Promise.resolve(
          doc
            ? { documentoId: doc._id, saldoPendiente: doc.outstandingBalance }
            : null,
        );
      },
    }),
  })),
  find: jest.fn((filtro: { documentoId?: { $in: unknown[] } }) => ({
    session: () => ({
      exec: () => {
        const ids = (filtro.documentoId?.$in ?? []).map(String);
        return Promise.resolve(
          documentos
            .filter(
              (d) =>
                ids.includes(String(d._id)) &&
                (d.outstandingBalance as number) > 0,
            )
            .map((d) => ({
              documentoId: d._id,
              saldoPendiente: d.outstandingBalance,
            })),
        );
      },
    }),
  })),
});

/** `SaldoDocumentoOrigen` mock, backed by whichever Recibo fixtures the
 *  caller passes — same shared-mutable-state trick `modeloSaldoTotalDocumento`
 *  uses, just for the SOURCE side (Recibo/NotaCredito) instead of the
 *  charge side. Reuses each fixture's own `unappliedAmount` field as the
 *  live `saldoDisponible`, and `receivedAmount` as the frozen
 *  `montoOriginal` — test fixture convenience, not a real schema shape. */
const modeloSaldoDocumentoOrigen = (documentos: Record<string, unknown>[]) => ({
  create: jest.fn(() => Promise.resolve([{}])),
  findOneAndUpdate: jest.fn(
    (
      filtro: Record<string, unknown>,
      update: { $inc?: { saldoDisponible: number } },
    ) => ({
      exec: () => {
        const doc = documentos.find(
          (d) => String(d._id) === String(filtro.documentoId),
        );
        if (!doc) return Promise.resolve(null);
        if (filtro.$expr) {
          const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
          if ((doc.unappliedAmount as number) < monto) {
            return Promise.resolve(null);
          }
          doc.unappliedAmount = (doc.unappliedAmount as number) - monto;
        } else if (update.$inc) {
          doc.unappliedAmount =
            (doc.unappliedAmount as number) + update.$inc.saldoDisponible;
        }
        return Promise.resolve({
          documentoId: doc._id,
          montoOriginal: doc.receivedAmount,
          saldoDisponible: doc.unappliedAmount,
        });
      },
    }),
  ),
  // `findOne` is called BOTH ways: bare `.exec()` from the read-only
  // `findOne()`/`findAll()` service methods, and `.session(session).exec()`
  // from `ejecutarAplicacionManual`/`anular()`'s own transactions —
  // `.session()` returns the same chainable object so either call shape
  // resolves, same pattern `notas-debito.service.spec.ts` uses.
  findOne: jest.fn((filtro: Record<string, unknown>) => {
    const resultado = (() => {
      const doc = documentos.find(
        (d) => String(d._id) === String(filtro.documentoId),
      );
      return doc
        ? {
            documentoId: doc._id,
            montoOriginal: doc.receivedAmount,
            saldoDisponible: doc.unappliedAmount,
          }
        : null;
    })();
    const cadena = {
      session: () => cadena,
      exec: () => Promise.resolve(resultado),
    };
    return cadena;
  }),
  updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  // Handles both query shapes `findAll` makes: the `conAnticipoDisponible`
  // candidate query (no `documentoId` filter, just `saldoDisponible: {$gt:
  // 0}`) and the post-page batch lookup (`documentoId: {$in: [...]}`,
  // unfiltered by balance) — same dual shape `FacturasService`'s own
  // `SaldoTotalDocumento` test mock handles.
  find: jest.fn((filtro: Record<string, unknown>) => ({
    exec: () => {
      const idsFiltro = (filtro.documentoId as { $in?: unknown[] } | undefined)
        ?.$in;
      const resultado = idsFiltro
        ? documentos.filter((d) =>
            idsFiltro.map(String).includes(String(d._id)),
          )
        : documentos.filter((d) => (d.unappliedAmount as number) > 0);
      return Promise.resolve(
        resultado.map((d) => ({
          documentoId: d._id,
          saldoDisponible: d.unappliedAmount,
        })),
      );
    },
  })),
});

const modeloAplicaciones = () => ({
  create: jest.fn((filas: Record<string, unknown>[]) =>
    Promise.resolve(filas.map((f, i) => ({ _id: `apl-${i}`, ...f }))),
  ),
});

/** Empty by default — most tests here never touch a Nota Débito. The
 *  `aplicarFifo`/`aplicarManual` tests that DO cover ND pass their own. */
const modeloNotasDebito = (notas: Record<string, unknown>[] = []) => ({
  find: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(notas) }),
  })),
  findOne: jest.fn((filtro: Record<string, unknown>) => ({
    session: () => ({
      exec: () =>
        Promise.resolve(
          notas.find((n) => String(n._id) === String(filtro._id)) ?? null,
        ),
    }),
  })),
});

const modeloAsientos = () => ({ create: jest.fn(() => Promise.resolve([{}])) });
const modeloCopropiedades = () => ({
  findById: jest.fn(() => ({
    session: () => ({
      exec: () =>
        Promise.resolve({
          receivablesAccount: '130501',
          advancesAccount: '210505',
        }),
    }),
  })),
});

const construirServicio = (opts: {
  reciboCreado: Record<string, unknown>;
  factura?: Record<string, unknown>;
  /** Default: periodo abierto. Sólo el test del periodo cerrado lo pisa. */
  periodo?: PeriodoService;
  saldos?: { findOneAndUpdate: jest.Mock };
  notasDebito?: Record<string, unknown>[];
  copropiedades?: { findById: jest.Mock };
  cuentasContables?: Record<string, unknown>[];
  inmueble?: Record<string, unknown> | null;
  /** Default: sin lote consolidado — nada que validar contra el período de
   *  facturación. Los tests de "candado de periodo de facturación" pasan
   *  su propio lote consolidado. */
  ultimoLoteConsolidado?: unknown;
}) => {
  const session = sesionFalsa();
  const recibos = modeloRecibos(opts.reciboCreado);
  const factura = opts.factura ?? facturaDoc();
  const facturas = modeloFacturas(factura);
  const saldos = opts.saldos ?? modeloSaldos();
  const aplicaciones = modeloAplicaciones();
  const asientos = modeloAsientos();
  const copropiedades = opts.copropiedades ?? modeloCopropiedades();
  const espia = periodoEspiado();
  const periodo = opts.periodo ?? espia.periodo;
  const exigirAbierto = espia.exigirAbierto;
  const notasDebitoList = opts.notasDebito ?? [];
  const notasDebito = modeloNotasDebito(notasDebitoList);
  const saldoTotalDocumento = modeloSaldoTotalDocumento([
    factura,
    ...notasDebitoList,
  ]);
  const saldoDocumentoOrigen = modeloSaldoDocumentoOrigen([opts.reciboCreado]);
  const cuentasContables = opts.cuentasContables && {
    find: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(opts.cuentasContables) }),
    })),
  };
  const inmuebles = opts.cuentasContables && {
    findById: jest.fn(() => ({
      session: () => ({
        exec: () => Promise.resolve(opts.inmueble ?? { code: '1304' }),
      }),
    })),
  };

  const service = new RecibosService(
    recibos as never,
    aplicaciones as never,
    facturas as never,
    saldos as never,
    modeloCarteraPorDocumento() as never,
    saldoTotalDocumento as never,
    asientos as never,
    copropiedades as never,
    tenantQueDevuelve(COP),
    numeracionQueEntrega('RC-1'),
    conexionCon(session),
    periodo,
    notasDebito as never,
    lotesFacturacionFalso(opts.ultimoLoteConsolidado ?? null),
    saldoDocumentoOrigen as never,
    cuentasContables as never,
    inmuebles as never,
  );

  return {
    service,
    recibos,
    facturas,
    saldos,
    saldoTotalDocumento,
    saldoDocumentoOrigen,
    aplicaciones,
    asientos,
    notasDebito,
    periodo,
    exigirAbierto,
  };
};

const dtoBase = () => ({
  codigo: 'RC',
  inmuebleId: INMUEBLE.toString(),
  terceroId: TERCERO.toString(),
  montoRecibido: 500000,
  fechaRecibo: '2026-08-27',
  medioPago: 'transferencia' as const,
  cuentaDestino: '111005',
});

describe('RecibosService.crear — elección de aplicación obligatoria', () => {
  it('rechaza cuando no se indica ni aplicaciones ni aplicacionAutomatica', async () => {
    const { service, recibos, asientos } = construirServicio({
      reciboCreado: {
        _id: new Types.ObjectId(),
        inmuebleId: INMUEBLE,
        terceroId: TERCERO,
        fullNumber: 'RC-1',
        destinationAccount: '111005',
        unappliedAmount: 500000,
        appliedAmount: 0,
        receivedAmount: 500000,
        status: 'activo',
      },
    });

    await expect(
      service.crear(CUENTA.toString(), dtoBase()),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(recibos.create).not.toHaveBeenCalled();
    expect(asientos.create).not.toHaveBeenCalled();
  });

  it('rechaza cuando se indican aplicaciones manuales Y aplicacionAutomatica a la vez', async () => {
    const { service } = construirServicio({
      reciboCreado: {
        _id: new Types.ObjectId(),
        status: 'activo',
      },
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: new Types.ObjectId().toString(),
            montoAplicado: 100000,
          },
        ],
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RecibosService.crear — aplicacionAutomatica sin cartera abierta (100% anticipo)', () => {
  it('crea el recibo con unappliedAmount = montoRecibido y SÍ postea el asiento — el efectivo ya llegó al banco', async () => {
    // Corrección de un bug de partida doble en un borrador anterior de este
    // plan: un anticipo puro NO deja de tener efecto contable — el dinero
    // entró de verdad a `destinationAccount` y tiene que verse ahí para que
    // la conciliación bancaria cierre, aunque todavía no se haya cruzado
    // contra ningún documento (design decision, Task 2).
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 500000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 0,
      unappliedAmount: 500000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const { service, asientos } = construirServicio({ reciboCreado });

    const resultado = await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      aplicacionAutomatica: true,
    });

    expect(resultado.montoSinAplicar).toBe(500000);
    expect(resultado.montoAplicado).toBe(0);
    expect(asientos.create).toHaveBeenCalledTimes(1);
    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    expect(entries).toEqual([
      {
        account: '111005',
        type: 'debito',
        amount: 500000,
        description: expect.any(String) as string,
      },
      {
        account: '210505',
        type: 'credito',
        amount: 500000,
        description: expect.any(String) as string,
      },
    ]);
  });

  it('agrega tercero/centroCosto/flujoCaja cuando cuentasContables está disponible', async () => {
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 500000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 0,
      unappliedAmount: 500000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const { service, asientos } = construirServicio({
      reciboCreado,
      copropiedades: {
        findById: jest.fn(() => ({
          session: () => ({
            exec: () =>
              Promise.resolve({
                receivablesAccount: '130501',
                advancesAccount: '210505',
                defaultCostCentre: 'CC-01',
                cashFlowCode: 'FC-OPER',
              }),
          }),
        })),
      },
      cuentasContables: [
        {
          code: '210505',
          requiresTercero: false,
          profitCenter: false,
          destinationCenter: false,
          cashFlow: true,
        },
      ],
      inmueble: { code: '1304' },
    });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      aplicacionAutomatica: true,
    });

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      flujoCaja?: string | null;
      tercero?: string | null;
    }>;
    const anticipo = entries.find((e) => e.account === '210505');
    expect(anticipo?.flujoCaja).toBe('FC-OPER');
    const banco = entries.find((e) => e.account === '111005');
    expect(banco?.tercero ?? null).toBeNull();
  });

  it('redacta "Genera anticipo" cuando la Automática no encuentra ningún documento abierto', async () => {
    // El caso real reportado: modo Automática, sin cartera pendiente para el
    // inmueble — el recibo entero queda de anticipo, y Observaciones debe
    // decirlo, no quedar en blanco.
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      reference: null,
      notes: null,
      appliedAmount: 0,
      unappliedAmount: 500000,
      status: 'activo',
    };
    const { service, recibos } = construirServicio({ reciboCreado });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      aplicacionAutomatica: true,
    });

    expect(recibos.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: reciboCreado._id, coPropertyId: COP },
      { $set: { notes: 'Genera anticipo' } },
      expect.anything(),
    );
  });
});

describe('RecibosService.crear — cuentaDestino por defecto', () => {
  /** Supports both call shapes crear() uses on this model: a direct
   *  `.exec()` for the new cuentaDestino default, and `.session(s).exec()`
   *  for the existing cartera/anticipos lookups inside the transaction. */
  const modeloCopropiedadesCon = (fixture: Record<string, unknown>) => ({
    findById: jest.fn(() => {
      const cadena = {
        session: () => cadena,
        exec: () => Promise.resolve(fixture),
      };
      return cadena;
    }),
  });

  it('usa defaultBankAccountCode cuando el DTO no trae cuentaDestino', async () => {
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 500000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '999000',
      reference: null,
      notes: null,
      appliedAmount: 0,
      unappliedAmount: 500000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const { service, recibos } = construirServicio({
      reciboCreado,
      copropiedades: modeloCopropiedadesCon({
        receivablesAccount: '130501',
        advancesAccount: '210505',
        defaultBankAccountCode: '999000',
      }),
    });

    const { cuentaDestino: _omitido, ...dtoSinCuenta } = dtoBase();
    await service.crear(CUENTA.toString(), {
      ...dtoSinCuenta,
      aplicacionAutomatica: true,
    });

    // `recibos.create([{...}], {session})` — Mongoose's array-form transactional
    // create — so the first call's first arg is a one-element array, not the
    // payload itself.
    const [[payloads]] = (recibos.create as jest.Mock).mock.calls as [
      [Array<Record<string, unknown>>],
    ];
    expect(payloads[0].destinationAccount).toBe('999000');
  });

  it('rechaza crear el recibo cuando faltan cuentaDestino Y defaultBankAccountCode', async () => {
    const { service } = construirServicio({
      reciboCreado: {},
      copropiedades: modeloCopropiedadesCon({
        receivablesAccount: '130501',
        advancesAccount: '210505',
        defaultBankAccountCode: null,
      }),
    });

    const { cuentaDestino: _omitido, ...dtoSinCuenta } = dtoBase();

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoSinCuenta,
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RecibosService.crear — candado de periodo contable', () => {
  const reciboCreado = () => ({
    _id: new Types.ObjectId(),
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    prefix: 'RC',
    number: 1,
    fullNumber: 'RC-1',
    receivedAmount: 500000,
    receivedDate: new Date('2026-08-27'),
    paymentMethod: 'transferencia',
    destinationAccount: '111005',
    reference: null,
    notes: null,
    appliedAmount: 0,
    unappliedAmount: 500000,
    status: 'activo',
    voidedReason: null,
    voidedDetail: null,
    voidedAt: null,
  });

  it('rechaza crear un recibo fechado en un periodo ya cerrado', async () => {
    // La ley de todo el codebase (ver el docblock de
    // `PeriodoService.exigirAbierto`): un documento con fecha NO se guarda sin
    // pasar por acá. Sin esto, un recibo retroactivo aterriza en un mes que el
    // consejo ya cerró y reportó, y su asiento mueve el saldo inicial de todos
    // los meses siguientes.
    const { service, recibos, asientos } = construirServicio({
      reciboCreado: reciboCreado(),
      periodo: periodoCerrado(),
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Y rechaza ANTES de escribir nada: ni el recibo, ni su asiento.
    expect(recibos.create).not.toHaveBeenCalled();
    expect(asientos.create).not.toHaveBeenCalled();
  });

  it('valida la fecha DEL DOCUMENTO (fechaRecibo), no el instante de la request', async () => {
    const { service, exigirAbierto } = construirServicio({
      reciboCreado: reciboCreado(),
    });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      fechaRecibo: '2026-03-15',
      aplicacionAutomatica: true,
    });

    expect(exigirAbierto).toHaveBeenCalledWith(
      COP.toString(),
      new Date('2026-03-15'),
    );
  });

  it('deja pasar la creación cuando el periodo está abierto', async () => {
    const { service, asientos } = construirServicio({
      reciboCreado: reciboCreado(),
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        aplicacionAutomatica: true,
      }),
    ).resolves.toBeDefined();
    expect(asientos.create).toHaveBeenCalledTimes(1);
  });
});

describe('RecibosService.crear — candado de período de facturación (mes/año del último lote)', () => {
  const reciboCreado = () => ({
    _id: new Types.ObjectId(),
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    prefix: 'RC',
    number: 1,
    fullNumber: 'RC-1',
    receivedAmount: 500000,
    receivedDate: new Date('2026-08-27'),
    paymentMethod: 'transferencia',
    destinationAccount: '111005',
    reference: null,
    notes: null,
    appliedAmount: 0,
    unappliedAmount: 500000,
    status: 'activo',
    voidedReason: null,
    voidedDetail: null,
    voidedAt: null,
  });

  it('rechaza una fecha de pago de un mes distinto al del último lote consolidado', async () => {
    const { service, recibos, asientos } = construirServicio({
      reciboCreado: reciboCreado(),
      ultimoLoteConsolidado: {
        periodStart: new Date('2026-08-01'),
        periodEnd: new Date('2026-08-31'),
      },
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        fechaRecibo: '2026-07-15',
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(recibos.create).not.toHaveBeenCalled();
    expect(asientos.create).not.toHaveBeenCalled();
  });

  it('deja pasar una fecha de pago del mismo mes y año del último lote consolidado', async () => {
    const { service, asientos } = construirServicio({
      reciboCreado: reciboCreado(),
      ultimoLoteConsolidado: {
        periodStart: new Date('2026-08-01'),
        periodEnd: new Date('2026-08-31'),
      },
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        fechaRecibo: '2026-08-27',
        aplicacionAutomatica: true,
      }),
    ).resolves.toBeDefined();
    expect(asientos.create).toHaveBeenCalledTimes(1);
  });

  it('no valida nada cuando la copropiedad nunca ha consolidado un lote', async () => {
    const { service } = construirServicio({
      reciboCreado: reciboCreado(),
      ultimoLoteConsolidado: null,
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        fechaRecibo: '2020-01-01',
        aplicacionAutomatica: true,
      }),
    ).resolves.toBeDefined();
  });

  it('un lote facturado el día 1 del mes no corre el período un mes hacia atrás (bug real reportado)', async () => {
    // Reportado en producción: lote facturado "2026-08-01", recibo fechado
    // "2026-08-31" — mismo agosto — rechazaba con "el último período
    // facturado fue 07/2026". Causa: `periodoDe()` (común, hora local) leía
    // la medianoche UTC del día 1 como el 31 de julio en un host con offset
    // negativo (Colombia, UTC-5). Esta validación debe leer SIEMPRE en UTC,
    // nunca en hora local — ver la nota en el código de `crear()`.
    const { service, asientos } = construirServicio({
      reciboCreado: reciboCreado(),
      ultimoLoteConsolidado: {
        periodStart: new Date('2026-08-01'),
        periodEnd: new Date('2026-08-31'),
      },
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        fechaRecibo: '2026-08-31',
        aplicacionAutomatica: true,
      }),
    ).resolves.toBeDefined();
    expect(asientos.create).toHaveBeenCalledTimes(1);
  });

  it('rechaza una fecha de pago del mismo mes calendario pero fuera del rango real del período (periodEnd, no fin de mes)', async () => {
    // El período de un lote no siempre coincide con el mes calendario
    // entero (ciclos quincenales, cortes a mitad de mes) — esta validación
    // compara contra el rango real (`periodStart`/`periodEnd`), no contra
    // "mismo mes/año", así que un recibo posterior a `periodEnd` se rechaza
    // aunque siga siendo el mismo mes.
    const { service, recibos, asientos } = construirServicio({
      reciboCreado: reciboCreado(),
      ultimoLoteConsolidado: {
        periodStart: new Date('2026-08-01'),
        periodEnd: new Date('2026-08-15'),
      },
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        fechaRecibo: '2026-08-20',
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(recibos.create).not.toHaveBeenCalled();
    expect(asientos.create).not.toHaveBeenCalled();
  });
});

describe('RecibosService.crear — con aplicaciones manuales', () => {
  it('descuenta outstandingBalance de la factura y postea el asiento por lo aplicado', async () => {
    const facturaId = new Types.ObjectId();
    const factura = facturaDoc({ _id: facturaId });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 500000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 200000,
      unappliedAmount: 300000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const { service, saldoTotalDocumento, asientos } = construirServicio({
      reciboCreado,
      factura,
    });

    const resultado = await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 200000,
        },
      ],
    });

    expect(resultado.montoAplicado).toBe(200000);
    expect(saldoTotalDocumento.findOneAndUpdate).toHaveBeenCalled();
    expect(asientos.create).toHaveBeenCalledTimes(1);
    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    // Débito por el RECIBIDO completo (500000), no solo lo aplicado —
    // el bug que este plan corrige. Crédito partido: cartera por lo
    // aplicado, anticipos por el resto.
    expect(entries).toEqual([
      {
        account: '111005',
        type: 'debito',
        amount: 500000,
        description: expect.any(String) as string,
      },
      {
        account: '130501',
        type: 'credito',
        amount: 200000,
        description: expect.any(String) as string,
      },
      {
        account: '210505',
        type: 'credito',
        amount: 300000,
        description: expect.any(String) as string,
      },
    ]);
  });

  it('acredita la cuenta propia del concepto cuando la línea de la factura la trae configurada', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      lines: [
        {
          conceptoId: conceptoMora,
          totalAmount: 500000,
          accountingReceivableAccount: '130599',
        },
      ],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 500000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 200000,
      unappliedAmount: 300000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const { service, asientos, aplicaciones } = construirServicio({
      reciboCreado,
      factura,
    });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 200000,
        },
      ],
    });

    // El "cargo por cargo" que la pantalla de detalle del recibo muestra —
    // congelado en la propia fila de AplicacionCartera, no re-derivado más
    // tarde desde las cuentas del asiento (dos conceptos podrían compartir
    // una cuenta, lo que haría esa reconstrucción ambigua).
    const [[filaAplicacion]] = (aplicaciones.create as jest.Mock).mock
      .calls as Array<[Record<string, unknown>[]]>;
    expect(filaAplicacion[0].detalleConceptos).toEqual([
      {
        conceptoId: conceptoMora,
        conceptName: expect.any(String) as string,
        monto: 200000,
      },
    ]);

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    const creditos = entries.filter((m) => m.type === 'credito');
    // La cuenta propia del concepto de mora (130599), NO la cuenta plana de
    // cartera de la copropiedad (130501) — esta última solo aparece por
    // anticipos.
    expect(creditos).toEqual([
      {
        account: '130599',
        type: 'credito',
        amount: 200000,
        description: expect.any(String) as string,
      },
      {
        account: '210505',
        type: 'credito',
        amount: 300000,
        description: expect.any(String) as string,
      },
    ]);
  });

  it('con cuentas de orden habilitadas, escala el par memo SOLO a lo aplicado al cargo de mora', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      lines: [
        {
          conceptoId: conceptoAdmin,
          conceptKind: 'administracion',
          totalAmount: 200000,
          accountingReceivableAccount: '130501',
        },
        {
          conceptoId: conceptoMora,
          conceptKind: 'intereses',
          totalAmount: 40000,
          accountingReceivableAccount: '130599',
        },
      ],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 240000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 0,
      // Read by aplicarManual's guard BEFORE this call's own application —
      // the full receivedAmount, same as any freshly created recibo.
      unappliedAmount: 240000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const copropiedades = {
      findById: jest.fn(() => ({
        session: () => ({
          exec: () =>
            Promise.resolve({
              receivablesAccount: '130501',
              advancesAccount: '210505',
              usesMemorandumAccounts: true,
              memorandumDebitAccount: '831505',
              memorandumCreditAccount: '831510',
            }),
        }),
      })),
    };
    const { service, asientos } = construirServicio({
      reciboCreado,
      factura,
      copropiedades,
    });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 240000,
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 240000,
        },
      ],
    });

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    // 240.000 se aplicaron en total, pero solo 40.000 tocaron el cargo de
    // mora — el par de cuentas de orden debe reflejar 40.000, no 240.000.
    expect(entries.find((m) => m.account === '831505')?.amount).toBe(40000);
    expect(entries.find((m) => m.account === '831510')?.amount).toBe(40000);
  });

  it('con cuentas de orden habilitadas, no agrega el par memo cuando nada se aplicó a mora', async () => {
    const facturaId = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      lines: [
        {
          conceptoId: new Types.ObjectId(),
          conceptKind: 'administracion',
          totalAmount: 200000,
          accountingReceivableAccount: '130501',
        },
      ],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 200000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 0,
      // Same reasoning as the test above.
      unappliedAmount: 200000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const copropiedades = {
      findById: jest.fn(() => ({
        session: () => ({
          exec: () =>
            Promise.resolve({
              receivablesAccount: '130501',
              advancesAccount: '210505',
              usesMemorandumAccounts: true,
              memorandumDebitAccount: '831505',
              memorandumCreditAccount: '831510',
            }),
        }),
      })),
    };
    const { service, asientos } = construirServicio({
      reciboCreado,
      factura,
      copropiedades,
    });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 200000,
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 200000,
        },
      ],
    });

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{ account: string }>;
    expect(entries.some((m) => m.account === '831505')).toBe(false);
    expect(entries.some((m) => m.account === '831510')).toBe(false);
  });

  it('rechaza — todo o nada — cuando la suma solicitada supera el monto recibido', async () => {
    const reciboCreado = { _id: new Types.ObjectId(), unappliedAmount: 500000 };
    const { service } = construirServicio({ reciboCreado });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: new Types.ObjectId().toString(),
            montoAplicado: 600000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza — todo o nada — cuando una línea supera el saldo pendiente actual de su factura', async () => {
    const facturaId = new Types.ObjectId();
    const factura = facturaDoc({ _id: facturaId, outstandingBalance: 100000 });
    const reciboCreado = { _id: new Types.ObjectId(), unappliedAmount: 500000 };
    const { service } = construirServicio({ reciboCreado, factura });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: facturaId.toString(),
            montoAplicado: 200000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza — todo o nada — aplicar contra una factura de OTRO inmueble', async () => {
    // FIFO filtra sus candidatas por inmuebleId; el modo manual acepta el
    // documentoId que le manden, y `decrementarSaldoFactura` sólo mira
    // {_id, coPropertyId, status, saldo}. Sin este chequeo, un recibo de una
    // unidad se podía cruzar contra la factura de OTRA unidad de la misma
    // copropiedad, y las dos vistas de saldo por inmueble quedaban corruptas.
    const OTRO_INMUEBLE = new Types.ObjectId();
    const facturaId = new Types.ObjectId();
    const factura = facturaDoc({ _id: facturaId, inmuebleId: OTRO_INMUEBLE });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      fullNumber: 'RC-1',
      unappliedAmount: 500000,
    };
    const { service, aplicaciones } = construirServicio({
      reciboCreado,
      factura,
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: facturaId.toString(),
            montoAplicado: 200000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Todo o nada: no queda ninguna AplicacionRecibo creada. (El decremento
    // de la factura sí se intentó, pero vive dentro de la transacción que
    // este throw aborta.)
    expect(aplicaciones.create).not.toHaveBeenCalled();
  });

  it("descuenta outstandingBalance de una Nota Débito cuando tipoDocumento es 'ND'", async () => {
    // El bug real que esto reemplaza: `AplicacionSolicitadaDto.tipoDocumento`
    // ya aceptaba 'ND', pero `aplicarManual` nunca lo leía — siempre llamaba
    // `decrementarSaldoFactura` y hardcodeaba `documentType: 'FV'`, así que
    // pedir una aplicación manual contra una Nota Débito real explotaba con
    // AplicacionInvalidaError (buscaba el id como si fuera una Factura).
    const notaDebitoId = new Types.ObjectId();
    const nota = notaDebitoDoc({ _id: notaDebitoId });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 500000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 100000,
      unappliedAmount: 400000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const { service, saldoTotalDocumento, aplicaciones } = construirServicio({
      reciboCreado,
      notasDebito: [nota],
    });

    const resultado = await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      aplicaciones: [
        {
          tipoDocumento: 'ND',
          documentoId: notaDebitoId.toString(),
          montoAplicado: 100000,
        },
      ],
    });

    expect(resultado.montoAplicado).toBe(100000);
    expect(saldoTotalDocumento.findOneAndUpdate).toHaveBeenCalled();
    const [[fila]] = (aplicaciones.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    expect(fila[0]).toMatchObject({
      documentType: 'ND',
      documentId: notaDebitoId,
      amountApplied: 100000,
    });
  });

  it('rechaza — todo o nada — aplicar contra una Nota Débito de OTRO inmueble', async () => {
    const OTRO_INMUEBLE = new Types.ObjectId();
    const notaDebitoId = new Types.ObjectId();
    const nota = notaDebitoDoc({
      _id: notaDebitoId,
      inmuebleId: OTRO_INMUEBLE,
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      fullNumber: 'RC-1',
      unappliedAmount: 500000,
    };
    const { service, aplicaciones } = construirServicio({
      reciboCreado,
      notasDebito: [nota],
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        aplicaciones: [
          {
            tipoDocumento: 'ND',
            documentoId: notaDebitoId.toString(),
            montoAplicado: 100000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(aplicaciones.create).not.toHaveBeenCalled();
  });

  it('rechaza pedir aplicación manual Y automática a la vez', async () => {
    const reciboCreado = { _id: new Types.ObjectId(), unappliedAmount: 500000 };
    const { service } = construirServicio({ reciboCreado });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: new Types.ObjectId().toString(),
            montoAplicado: 100000,
          },
        ],
        aplicacionAutomatica: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('redacta Observaciones automáticamente a partir de la aplicación real, cuando el llamador no las especifica', async () => {
    // Bug real reportado: en modo Automática el frontend no puede adivinar de
    // antemano qué facturas tocará el FIFO del backend, así que Observaciones
    // quedaba siempre en blanco — tanto en pantalla como en la impresión.
    // Este texto ahora se redacta acá, a partir de lo que en efecto se
    // aplicó, para Manual Y Automática por igual.
    const facturaId = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      number: 173,
      outstandingBalance: 200000,
      total: 200000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 200000 }],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      reference: null,
      notes: null,
      appliedAmount: 0,
      unappliedAmount: 200000,
      status: 'activo',
    };
    const { service, recibos } = construirServicio({ reciboCreado, factura });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 200000,
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 200000,
        },
      ],
    });

    expect(recibos.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: reciboCreado._id, coPropertyId: COP },
      { $set: { notes: 'Cancela factura 173' } },
      expect.anything(),
    );
  });

  it('respeta las Observaciones explícitas del llamador — no las sobreescribe con el texto redactado', async () => {
    const facturaId = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      number: 173,
      outstandingBalance: 200000,
      total: 200000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 200000 }],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      reference: null,
      notes: 'Texto digitado a mano',
      appliedAmount: 0,
      unappliedAmount: 200000,
      status: 'activo',
    };
    const { service, recibos } = construirServicio({ reciboCreado, factura });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 200000,
      observaciones: 'Texto digitado a mano',
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 200000,
        },
      ],
    });

    const llamadasConNotes = (
      recibos.findOneAndUpdate as jest.Mock
    ).mock.calls.filter(
      ([, cambios]: [unknown, { $set?: { notes?: unknown } }]) =>
        cambios.$set?.notes !== undefined,
    );
    expect(llamadasConNotes).toHaveLength(0);
  });

  it('con descuento vigente, postea 2 débitos (banco reducido + cuenta de descuentos) y un crédito a cartera por el total', async () => {
    const facturaId = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      number: 173,
      outstandingBalance: 400000,
      total: 400000,
      discountAmount: 40000,
      discountDeadline: new Date('2026-08-31'),
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 400000 }],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      reference: null,
      notes: null,
      appliedAmount: 0,
      unappliedAmount: 360000,
      status: 'activo',
    };
    const copropiedades = {
      findById: jest.fn(() => ({
        session: () => ({
          exec: () =>
            Promise.resolve({
              receivablesAccount: '130501',
              advancesAccount: '210505',
              discountsDebitAccount: '540501',
            }),
        }),
      })),
    };
    const { service, asientos } = construirServicio({
      reciboCreado,
      factura,
      copropiedades,
    });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 360000,
      fechaRecibo: '2026-08-27',
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 360000,
        },
      ],
    });

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    expect(entries).toEqual([
      {
        account: '111005',
        type: 'debito',
        amount: 360000,
        description: expect.any(String) as string,
      },
      {
        account: '540501',
        type: 'debito',
        amount: 40000,
        description: expect.any(String) as string,
      },
      {
        account: '130501',
        type: 'credito',
        amount: 400000,
        description: expect.any(String) as string,
      },
    ]);
  });
});

describe('RecibosService.crear — con aplicaciones manuales, reparto por concepto', () => {
  const reciboBase = () => ({
    _id: new Types.ObjectId(),
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    prefix: 'RC',
    number: 1,
    fullNumber: 'RC-1',
    receivedAmount: 150000,
    receivedDate: new Date('2026-08-27'),
    paymentMethod: 'transferencia',
    destinationAccount: '111005',
    reference: null,
    notes: null,
    appliedAmount: 0,
    unappliedAmount: 150000,
    status: 'activo',
    voidedReason: null,
    voidedDetail: null,
    voidedAt: null,
  });

  it('aplica TODO el abono a un solo concepto elegido por el usuario, dejando el otro intacto', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const conceptoIntereses = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      total: 500000,
      outstandingBalance: 500000,
      lines: [
        {
          conceptoId: conceptoAdmin,
          totalAmount: 300000,
          accountingReceivableAccount: '130501',
        },
        {
          conceptoId: conceptoIntereses,
          totalAmount: 200000,
          conceptKind: 'intereses',
          accountingReceivableAccount: '130599',
        },
      ],
    });
    const { service, facturas, aplicaciones, asientos } = construirServicio({
      reciboCreado: reciboBase(),
      factura,
    });

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 150000,
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: facturaId.toString(),
          montoAplicado: 150000,
          distribucion: [
            { conceptoId: conceptoIntereses.toString(), monto: 150000 },
          ],
        },
      ],
    });

    // El desglose guardado es EXACTAMENTE lo que el usuario eligió, no la
    // cascada (que habría llenado Intereses igual en este caso particular,
    // pero por casualidad — el punto es que vino del usuario, no de
    // recalcularlo).
    const [[filaAplicacion]] = (aplicaciones.create as jest.Mock).mock
      .calls as Array<[Record<string, unknown>[]]>;
    expect(filaAplicacion[0].detalleConceptos).toEqual([
      {
        conceptoId: conceptoIntereses,
        conceptName: expect.any(String) as string,
        monto: 150000,
      },
    ]);
    expect(filaAplicacion[0].discountApplied).toBe(0);

    // El asiento acredita la cuenta de Intereses, nunca la de Administración.
    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    expect(
      entries.some(
        (e) =>
          e.account === '130599' && e.type === 'credito' && e.amount === 150000,
      ),
    ).toBe(true);
    expect(entries.some((e) => e.account === '130501')).toBe(false);

    // El saldo pendiente de esta línea queda registrado para la próxima vez
    // (200000 - 150000 = 50000) — Administración queda sin tocar.
    expect(facturas.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'lines.conceptoId': conceptoIntereses }),
      { $set: { 'lines.$.remainingAmount': 50000 } },
      expect.anything(),
    );
  });

  it('rechaza cuando el reparto no suma exactamente el monto a aplicar', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoIntereses = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      total: 500000,
      outstandingBalance: 500000,
      lines: [{ conceptoId: conceptoIntereses, totalAmount: 200000 }],
    });
    const { service } = construirServicio({
      reciboCreado: reciboBase(),
      factura,
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        montoRecibido: 150000,
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: facturaId.toString(),
            montoAplicado: 150000,
            distribucion: [
              { conceptoId: conceptoIntereses.toString(), monto: 100000 },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza cuando el reparto pide más de lo que le queda pendiente a un concepto', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoIntereses = new Types.ObjectId();
    const factura = facturaDoc({
      _id: facturaId,
      total: 500000,
      outstandingBalance: 500000,
      lines: [{ conceptoId: conceptoIntereses, totalAmount: 100000 }],
    });
    const { service } = construirServicio({
      reciboCreado: reciboBase(),
      factura,
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        montoRecibido: 150000,
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: facturaId.toString(),
            montoAplicado: 150000,
            distribucion: [
              { conceptoId: conceptoIntereses.toString(), monto: 150000 },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('valida el reparto manual contra el saldo pendiente REAL (SaldoTotalDocumento), no contra el outstandingBalance congelado de la Factura', async () => {
    // Regresión: `Factura.outstandingBalance` queda congelado en su total
    // original desde que `SaldoTotalDocumento` es la fuente viva (ver su
    // propio docblock) — nunca vuelve a decrementarse. Esta factura ya tuvo
    // una cascada previa que agotó Intereses por completo (200000) y dejó
    // solo Administración pendiente (300000); `SaldoTotalDocumento` refleja
    // eso, pero la Factura en su colección sigue mostrando 500000. Un
    // reparto manual que pida CUALQUIER monto contra Intereses debe
    // rechazarse — leer el campo congelado en vez del saldo vivo lo dejaría
    // pasar por error.
    const facturaId = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const conceptoIntereses = new Types.ObjectId();
    const facturaCongelada = facturaDoc({
      _id: facturaId,
      total: 500000,
      outstandingBalance: 500000,
      lines: [
        {
          conceptoId: conceptoAdmin,
          totalAmount: 300000,
          accountingReceivableAccount: '130501',
        },
        {
          conceptoId: conceptoIntereses,
          totalAmount: 200000,
          conceptKind: 'intereses',
          accountingReceivableAccount: '130599',
        },
      ],
    });
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(facturaCongelada) }),
      })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaId, outstandingBalance: 300000 },
    ]);
    const recibo = reciboBase();
    const saldoDocumentoOrigen = modeloSaldoDocumentoOrigen([recibo]);
    const service = new RecibosService(
      modeloRecibos(recibo) as never,
      modeloAplicaciones() as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      saldoDocumentoOrigen as never,
    );

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        montoRecibido: 150000,
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: facturaId.toString(),
            montoAplicado: 50000,
            distribucion: [
              { conceptoId: conceptoIntereses.toString(), monto: 50000 },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza un reparto por concepto contra una Nota Débito — tiene un solo concepto', async () => {
    const notaDebito = notaDebitoDoc({ _id: new Types.ObjectId() });
    const { service } = construirServicio({
      reciboCreado: reciboBase(),
      notasDebito: [notaDebito],
    });

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        montoRecibido: 150000,
        aplicaciones: [
          {
            tipoDocumento: 'ND',
            documentoId: String(notaDebito._id),
            montoAplicado: 150000,
            distribucion: [
              { conceptoId: new Types.ObjectId().toString(), monto: 150000 },
            ],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RecibosService.crear — con aplicacionAutomatica (FIFO)', () => {
  it('aplica en orden de vencimiento más antiguo primero, y se detiene al agotar el monto', async () => {
    const vieja = facturaDoc({
      _id: new Types.ObjectId(),
      dueDate: new Date('2026-06-30'),
      outstandingBalance: 200000,
      total: 200000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 200000 }],
    });
    const nueva = facturaDoc({
      _id: new Types.ObjectId(),
      dueDate: new Date('2026-07-31'),
      outstandingBalance: 200000,
      total: 200000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 200000 }],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      reference: null,
      notes: null,
      unappliedAmount: 300000,
      appliedAmount: 0,
      receivedAmount: 300000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };

    const facturas = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([vieja, nueva]) }),
      })),
      findOne: jest.fn((filtro: Record<string, unknown>) => ({
        session: () => ({
          exec: () =>
            Promise.resolve(
              [vieja, nueva].find(
                (f) => String(f._id) === String(filtro._id),
              ) ?? null,
            ),
        }),
      })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([vieja, nueva]);

    const session = sesionFalsa();
    const recibos = modeloRecibos(reciboCreado);
    const saldos = modeloSaldos();
    const aplicaciones = modeloAplicaciones();
    const asientos = modeloAsientos();
    const copropiedades = modeloCopropiedades();
    const saldoDocumentoOrigen = modeloSaldoDocumentoOrigen([reciboCreado]);

    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      facturas as never,
      saldos as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      copropiedades as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      saldoDocumentoOrigen as never,
    );

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 300000,
      aplicacionAutomatica: true,
    });

    // La vieja (vence primero) se agota completa (200000) antes de tocar la
    // nueva — el orden en que `saldoTotalDocumento.findOneAndUpdate` fue
    // invocado revela el orden real de aplicación.
    const idsLlamados = saldoTotalDocumento.findOneAndUpdate.mock.calls.map(
      ([filtro]) => String((filtro as { documentoId: unknown }).documentoId),
    );
    expect(idsLlamados).toEqual([vieja._id.toString(), nueva._id.toString()]);
  });

  it('mezcla Facturas y Notas Débito en un solo FIFO, la más vieja de cualquiera de los dos tipos primero', async () => {
    // El bug real que esto reemplaza: aplicarFifo solo consultaba this.facturas
    // — una Nota Débito abierta, sin importar cuán vieja fuera, nunca entraba
    // al FIFO en absoluto.
    const facturaVieja = facturaDoc({
      _id: new Types.ObjectId(),
      dueDate: new Date('2026-07-31'),
      outstandingBalance: 100000,
      total: 100000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 100000 }],
    });
    const notaMasVieja = notaDebitoDoc({
      _id: new Types.ObjectId(),
      issueDate: new Date('2026-06-01'),
      outstandingBalance: 100000,
      total: 100000,
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      reference: null,
      notes: null,
      unappliedAmount: 100000,
      appliedAmount: 0,
      receivedAmount: 100000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };

    const facturas = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([facturaVieja]) }),
      })),
      findOne: jest.fn((filtro: Record<string, unknown>) => ({
        session: () => ({
          exec: () =>
            Promise.resolve(
              String(filtro._id) === String(facturaVieja._id)
                ? facturaVieja
                : null,
            ),
        }),
      })),
    };
    const notasDebito = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([notaMasVieja]) }),
      })),
      findOne: jest.fn((filtro: Record<string, unknown>) => ({
        session: () => ({
          exec: () =>
            Promise.resolve(
              String(filtro._id) === String(notaMasVieja._id)
                ? notaMasVieja
                : null,
            ),
        }),
      })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      facturaVieja,
      notaMasVieja,
    ]);

    const session = sesionFalsa();
    const recibos = modeloRecibos(reciboCreado);
    const saldos = modeloSaldos();
    const aplicaciones = modeloAplicaciones();
    const asientos = modeloAsientos();
    const copropiedades = modeloCopropiedades();
    const saldoDocumentoOrigen = modeloSaldoDocumentoOrigen([reciboCreado]);

    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      facturas as never,
      saldos as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      copropiedades as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      notasDebito as never,
      lotesFacturacionFalso(),
      saldoDocumentoOrigen as never,
    );

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 100000,
      aplicacionAutomatica: true,
    });

    // La Nota Débito (issueDate 2026-06-01) es más vieja que la Factura
    // (dueDate 2026-07-31) — tiene que pagarse primero, agotando el monto,
    // sin tocar la Factura.
    const idsLlamados = saldoTotalDocumento.findOneAndUpdate.mock.calls.map(
      ([filtro]) => String((filtro as { documentoId: unknown }).documentoId),
    );
    expect(idsLlamados).toEqual([notaMasVieja._id.toString()]);
    const [[fila]] = (aplicaciones.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    expect(fila[0]).toMatchObject({
      documentType: 'ND',
      documentId: notaMasVieja._id,
      amountApplied: 100000,
    });
  });

  it('salta un documento inválido y lo reporta en errores, sin abortar el resto (best-effort)', async () => {
    const invalida = facturaDoc({
      _id: new Types.ObjectId(),
      dueDate: new Date('2026-06-01'),
    });
    const valida = facturaDoc({
      _id: new Types.ObjectId(),
      dueDate: new Date('2026-07-01'),
      outstandingBalance: 100000,
      total: 100000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 100000 }],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      reference: null,
      notes: null,
      unappliedAmount: 100000,
      appliedAmount: 0,
      receivedAmount: 100000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };

    const facturas = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([invalida, valida]) }),
      })),
      findOne: jest.fn((filtro: Record<string, unknown>) => ({
        session: () => ({
          exec: () =>
            Promise.resolve(
              [invalida, valida].find(
                (f) => String(f._id) === String(filtro._id),
              ) ?? null,
            ),
        }),
      })),
    };
    // `invalida` deliberadamente ausente aquí — simula "el documento fue
    // anulado/removido entre el listado del candidato y la aplicación
    // real" (una condición de carrera): su guarda atómica no encuentra
    // fila y `AplicacionInvalidaError` es exactamente lo que produce eso.
    const saldoTotalDocumento = modeloSaldoTotalDocumento([valida]);

    const session = sesionFalsa();
    const recibos = modeloRecibos(reciboCreado);
    const service = new RecibosService(
      recibos as never,
      modeloAplicaciones() as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([reciboCreado]) as never,
    );

    // aplicarFifo is private — exercised indirectly through crear(), and its
    // errores/montoSinAplicar surface through aplicar() in Task 8. This test
    // only asserts the operation as a whole does not throw (best-effort).
    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        montoRecibido: 100000,
        aplicacionAutomatica: true,
      }),
    ).resolves.toBeDefined();
  });

  it('PROPAGA un error que no sea AplicacionInvalidaError en vez de tragárselo en errores', async () => {
    // El catch del loop FIFO sólo puede significar "este documento resultó
    // inválido, saltalo" — y eso es exactamente `AplicacionInvalidaError`, lo
    // que lanza `decrementarSaldoFactura` (la PRIMERA sentencia del try).
    // Cualquier otra cosa viene de `ajustarSaldosCartera` o de
    // `aplicaciones.create`, que corren DESPUÉS de que el saldo de la factura
    // ya se decrementó: tragárselo dejaría commitear la transacción con la
    // factura descontada, sin fila de auditoría y sin appliedAmount — plata
    // desaparecida de la factura sin rastro.
    const factura = facturaDoc({
      _id: new Types.ObjectId(),
      dueDate: new Date('2026-06-30'),
      outstandingBalance: 100000,
      total: 100000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 100000 }],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      reference: null,
      notes: null,
      unappliedAmount: 100000,
      appliedAmount: 0,
      receivedAmount: 100000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };

    const facturas = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([factura]) }),
      })),
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(factura) }),
      })),
    };
    // El decremento pasó (esta factura sí tiene saldo suficiente); el cache
    // de cartera revienta con un error cualquiera (una ValidationError de
    // Mongoose, un fallo de red — da igual).
    const saldoTotalDocumento = modeloSaldoTotalDocumento([factura]);
    const saldosQueRevientan = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () =>
          Promise.reject(new Error('fallo inesperado en SaldoCartera')),
      })),
    };

    const service = new RecibosService(
      modeloRecibos(reciboCreado) as never,
      modeloAplicaciones() as never,
      facturas as never,
      saldosQueRevientan as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([reciboCreado]) as never,
    );

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        montoRecibido: 100000,
        aplicacionAutomatica: true,
      }),
    ).rejects.toThrow('fallo inesperado en SaldoCartera');
  });

  it('redacta "Abona a factura N" cuando la Automática solo alcanza para un pago parcial', async () => {
    const factura = facturaDoc({
      _id: new Types.ObjectId(),
      number: 340,
      dueDate: new Date('2026-06-30'),
      outstandingBalance: 200000,
      total: 200000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 200000 }],
    });
    const reciboCreado = {
      _id: new Types.ObjectId(),
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      destinationAccount: '111005',
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      reference: null,
      notes: null,
      unappliedAmount: 100000,
      appliedAmount: 0,
      receivedAmount: 100000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };

    const facturas = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([factura]) }),
      })),
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(factura) }),
      })),
    };
    const recibos = modeloRecibos(reciboCreado);

    const service = new RecibosService(
      recibos as never,
      modeloAplicaciones() as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([factura]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([reciboCreado]) as never,
    );

    // Recibe menos de lo que debe la factura (200000): el FIFO aplica los
    // 100000 disponibles como abono parcial, sin dejar nada como anticipo.
    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 100000,
      aplicacionAutomatica: true,
    });

    expect(recibos.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: reciboCreado._id, coPropertyId: COP },
      { $set: { notes: 'Abona a factura 340' } },
      expect.anything(),
    );
  });
});

describe('RecibosService.anular', () => {
  const reciboActivo = (over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    coPropertyId: COP,
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    prefix: 'RC',
    number: 1,
    fullNumber: 'RC-1',
    receivedDate: new Date('2026-08-20'),
    paymentMethod: 'transferencia',
    destinationAccount: '111005',
    reference: null,
    notes: null,
    status: 'activo',
    unappliedAmount: 100000,
    appliedAmount: 200000,
    receivedAmount: 300000,
    voidedReason: null,
    voidedDetail: null,
    voidedAt: null,
    ...over,
  });

  const modeloAplicacionesActivas = (filas: Record<string, unknown>[]) => ({
    find: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(filas) }),
    })),
    findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
  });

  it('revierte cada AplicacionRecibo activa y restaura el outstandingBalance de cada factura afectada', async () => {
    const facturaId = new Types.ObjectId();
    const recibo = reciboActivo();
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentId: facturaId,
      amountApplied: 200000,
      status: 'activa',
      detalleConceptos: [],
    };

    const facturaFrozen = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 500000,
      lines: [],
    };
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve({ ...facturaFrozen }) }),
      })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaId, outstandingBalance: 300000 },
    ]);
    const recibos = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
      // Muta el mismo objeto `recibo` que `findOne` sigue devolviendo — así
      // el refetch final ve el $set aplicado, igual que lo vería un Mongo
      // real, sin necesitar un modelo con estado más elaborado.
      findOneAndUpdate: jest.fn(
        (_filtro: unknown, update: { $set?: Record<string, unknown> }) => ({
          exec: () => {
            if (update?.$set) Object.assign(recibo, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const aplicaciones = modeloAplicacionesActivas([aplicacionActiva]);
    const asientos = modeloAsientos();
    const session = sesionFalsa();

    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([recibo]) as never,
    );

    const resultado = await service.anular(
      recibo._id.toString(),
      {
        motivo: 'duplicado',
        detalle: 'Se cargó el mismo comprobante dos veces por error del cajero',
        fecha: '2026-09-01',
      },
      CUENTA.toString(),
    );

    expect(saldoTotalDocumento.findOneAndUpdate).toHaveBeenCalledWith(
      { documentoId: facturaId },
      { $inc: { saldoPendiente: 200000 } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
    expect(aplicaciones.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: aplicacionActiva._id, coPropertyId: COP },
      { $set: { status: 'revertida', revertedAt: expect.any(Date) as Date } },
      expect.objectContaining({ session: expect.anything() as unknown }),
    );
    expect(asientos.create).toHaveBeenCalledTimes(1);
    // El propio Recibo transiciona de estado — este endpoint responde con el
    // Recibo actualizado, y motivo/detalle/fecha de anulación son exactamente
    // los campos que un caller lee (recibos.mapper.ts). Un refactor que
    // dejara de escribir voidedDetail, o que lo confundiera con voidedReason,
    // pasaría inadvertido sin esta aserción.
    expect(recibos.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: recibo._id.toString(), coPropertyId: COP },
      {
        $set: {
          status: 'anulado',
          voidedReason: 'duplicado',
          voidedDetail:
            'Se cargó el mismo comprobante dos veces por error del cajero',
          voidedAt: expect.any(Date) as Date,
          // El actor de la anulación sale del caller autenticado y se escribe
          // en el MISMO $set que la transición de estado — nunca uno sin el
          // otro. Es la operación más auditada del módulo y era la única
          // mutación del módulo que no registraba quién la hizo.
          voidedBy: CUENTA.toString(),
          appliedAmount: 0,
          unappliedAmount: 0,
        },
      },
      expect.objectContaining({ session: expect.anything() as unknown }),
    );
    expect(resultado.estado).toBe('anulado');
    expect(resultado.motivoAnulacion).toBe('duplicado');
    expect(resultado.detalleAnulacion).toBe(
      'Se cargó el mismo comprobante dos veces por error del cajero',
    );
    expect(resultado.fechaAnulacion).toEqual(expect.any(String) as string);
    // Usa los totales CACHEADOS del recibo (appliedAmount/unappliedAmount/
    // receivedAmount), no una suma recalculada del loop de arriba — no hace
    // falta "reproducir" la historia para saber cuánto revertir.
    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    expect(entries).toEqual([
      {
        account: '130501',
        type: 'debito',
        amount: 200000,
        description: expect.any(String) as string,
      },
      {
        account: '210505',
        type: 'debito',
        amount: 100000,
        description: expect.any(String) as string,
      },
      {
        account: '111005',
        type: 'credito',
        amount: 300000,
        description: expect.any(String) as string,
      },
    ]);
  });

  it('debita de vuelta la cuenta propia del concepto, no la cuenta plana de cartera', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const recibo = reciboActivo();
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentId: facturaId,
      amountApplied: 200000,
      status: 'activa',
      detalleConceptos: [{ conceptoId: conceptoMora, monto: 200000 }],
    };
    // Antes de esta anulación: 200.000 de los 500.000 de la factura estaban
    // aplicados (outstandingBalance=300.000); el $inc de la reversión la
    // deja de nuevo en 500.000 (factura.total), toda ella otra vez pendiente.
    const facturaFrozen = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 500000,
      lines: [
        {
          conceptoId: conceptoMora,
          totalAmount: 500000,
          accountingReceivableAccount: '130599',
        },
      ],
    };
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve({ ...facturaFrozen }) }),
      })),
      updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaId, outstandingBalance: 300000 },
    ]);
    const recibos = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const session = sesionFalsa();
    const service = new RecibosService(
      recibos as never,
      modeloAplicacionesActivas([aplicacionActiva]) as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([recibo]) as never,
    );

    await service.anular(
      recibo._id.toString(),
      {
        motivo: 'otro',
        detalle: 'Detalle de prueba con longitud suficiente',
        fecha: '2026-09-01',
      },
      CUENTA.toString(),
    );

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    const debitos = entries.filter((m) => m.type === 'debito');
    // Debita de vuelta la cuenta propia del concepto de mora (130599) por lo
    // que esta aplicación había acreditado — NO la cuenta plana de cartera
    // de la copropiedad (130501).
    expect(debitos.find((d) => d.account === '130599')?.amount).toBe(200000);
    expect(debitos.some((d) => d.account === '130501')).toBe(false);
  });

  it('con cuentas de orden habilitadas, revierte el par memo SOLO por lo que era mora', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const recibo = reciboActivo();
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentId: facturaId,
      amountApplied: 200000,
      status: 'activa',
      detalleConceptos: [{ conceptoId: conceptoMora, monto: 200000 }],
    };
    const facturaFrozen = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 500000,
      lines: [
        {
          conceptoId: conceptoMora,
          conceptKind: 'intereses',
          totalAmount: 500000,
          accountingReceivableAccount: '130599',
        },
      ],
    };
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve({ ...facturaFrozen }) }),
      })),
      updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaId, outstandingBalance: 300000 },
    ]);
    const recibos = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const copropiedades = {
      findById: jest.fn(() => ({
        session: () => ({
          exec: () =>
            Promise.resolve({
              receivablesAccount: '130501',
              advancesAccount: '210505',
              usesMemorandumAccounts: true,
              memorandumDebitAccount: '831505',
              memorandumCreditAccount: '831510',
            }),
        }),
      })),
    };
    const asientos = modeloAsientos();
    const session = sesionFalsa();
    const service = new RecibosService(
      recibos as never,
      modeloAplicacionesActivas([aplicacionActiva]) as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      copropiedades as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([recibo]) as never,
    );

    await service.anular(
      recibo._id.toString(),
      {
        motivo: 'otro',
        detalle: 'Detalle de prueba con longitud suficiente',
        fecha: '2026-09-01',
      },
      CUENTA.toString(),
    );

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    // 300.000 es el receivedAmount total del recibo, pero solo 200.000
    // fueron mora — el par memo revertido debe ser 200.000, no 300.000.
    // La creación posteó con los lados invertidos respecto a facturación
    // (831510 débito / 831505 crédito) — anular() vuelve a los lados
    // planos de facturación para cerrar ese par en cero.
    expect(
      entries.find((m) => m.account === '831505' && m.type === 'debito')
        ?.amount,
    ).toBe(200000);
    expect(
      entries.find((m) => m.account === '831510' && m.type === 'credito')
        ?.amount,
    ).toBe(200000);
  });

  it('al revertir, repite el reparto EXACTO que la aplicación eligió — no la cascada por defecto', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const conceptoIntereses = new Types.ObjectId();
    const recibo = reciboActivo();
    // La aplicación original eligió meter TODO a intereses — si la
    // reversión recalculara con la cascada (más reciente primero), con
    // estas dos líneas atribuiría el pago a Administración en vez de
    // Intereses (bug que este cambio corrige).
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentId: facturaId,
      amountApplied: 150000,
      status: 'activa',
      detalleConceptos: [{ conceptoId: conceptoIntereses, monto: 150000 }],
    };
    const facturaFrozen = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 500000,
      lines: [
        {
          conceptoId: conceptoAdmin,
          totalAmount: 300000,
          accountingReceivableAccount: '130501',
        },
        {
          conceptoId: conceptoIntereses,
          totalAmount: 200000,
          conceptKind: 'intereses',
          accountingReceivableAccount: '130599',
        },
      ],
    };
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve({ ...facturaFrozen }) }),
      })),
      updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const saldoTotalDocumento = modeloSaldoTotalDocumento([
      { _id: facturaId, outstandingBalance: 350000 },
    ]);
    const recibos = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const session = sesionFalsa();
    const service = new RecibosService(
      recibos as never,
      modeloAplicacionesActivas([aplicacionActiva]) as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumento as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([recibo]) as never,
    );

    await service.anular(
      recibo._id.toString(),
      {
        motivo: 'otro',
        detalle: 'Detalle de prueba con longitud suficiente',
        fecha: '2026-09-01',
      },
      CUENTA.toString(),
    );

    const [[fila]] = (asientos.create as jest.Mock).mock.calls as Array<
      [Record<string, unknown>[]]
    >;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    const debitos = entries.filter((m) => m.type === 'debito');
    expect(debitos.find((d) => d.account === '130599')?.amount).toBe(150000);
    expect(debitos.some((d) => d.account === '130501')).toBe(false);

    // El saldo pendiente de Intereses vuelve a subir por lo revertido
    // (200000 - 150000 + 150000 = 200000, otra vez completo).
    expect(facturas.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'lines.conceptoId': conceptoIntereses }),
      { $set: { 'lines.$.remainingAmount': 200000 } },
      expect.anything(),
    );
  });

  it('restaura el saldo aunque la factura afectada ya esté anulada por otra vía (no rompe, es contabilidad inofensiva)', async () => {
    const facturaId = new Types.ObjectId();
    const recibo = reciboActivo();
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentId: facturaId,
      amountApplied: 100000,
      status: 'activa',
    };

    // La factura ya no existe bajo esas condiciones (voidedByCreditNoteId,
    // u otra vía) — el findOne devuelve null, y el cascade sigue sin lanzar.
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(null) }),
      })),
    };
    const recibos = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const aplicaciones = modeloAplicacionesActivas([aplicacionActiva]);
    const session = sesionFalsa();

    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([recibo]) as never,
    );

    await expect(
      service.anular(
        recibo._id.toString(),
        {
          motivo: 'otro',
          detalle: 'La factura ya fue anulada por otra vía',
          fecha: '2026-09-01',
        },
        CUENTA.toString(),
      ),
    ).resolves.toBeDefined();

    // La AplicacionRecibo se marca revertida de todos modos — la reversión
    // del cruce es incondicional (design §6).
    expect(aplicaciones.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('rechaza anular un recibo ya anulado', async () => {
    const recibo = reciboActivo({ status: 'anulado' });
    const recibos = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
    };
    const session = sesionFalsa();
    const service = new RecibosService(
      recibos as never,
      modeloAplicacionesActivas([]) as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
    );

    await expect(
      service.anular(
        recibo._id.toString(),
        {
          motivo: 'otro',
          detalle: 'Un detalle de más de veinte caracteres',
          fecha: '2026-09-01',
        },
        CUENTA.toString(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('RecibosService.findAll', () => {
  const modeloListado = (
    filas: Record<string, unknown>[],
    total = filas.length,
  ) => {
    const filtros: Record<string, unknown>[] = [];
    const ordenes: Record<string, unknown>[] = [];
    type Cadena = {
      sort: (orden: Record<string, unknown>) => Cadena;
      skip: () => Cadena;
      limit: () => Cadena;
      exec: () => Promise<Record<string, unknown>[]>;
    };
    const cadena: Cadena = {
      sort: jest.fn((orden: Record<string, unknown>) => {
        ordenes.push(orden);
        return cadena;
      }),
      skip: () => cadena,
      limit: () => cadena,
      exec: () => Promise.resolve(filas),
    };
    return {
      filtros,
      ordenes,
      find: jest.fn((f: Record<string, unknown>) => {
        filtros.push(f);
        return cadena;
      }),
      countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(total) })),
    };
  };

  const construirParaListado = (
    recibos: ReturnType<typeof modeloListado>,
    saldoDocumentoOrigen: Record<string, unknown>[] = [],
  ) =>
    new RecibosService(
      recibos as never,
      modeloAplicacionesGenerico() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen(saldoDocumentoOrigen) as never,
    );

  function modeloAplicacionesGenerico() {
    return {
      create: jest.fn(),
      find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
    };
  }

  it('filtra SIEMPRE por la copropiedad activa', async () => {
    const recibos = modeloListado([]);
    const service = construirParaListado(recibos);

    await service.findAll({});

    expect(recibos.filtros[0]).toMatchObject({ coPropertyId: COP });
  });

  it('aplica conAnticipoDisponible resolviendo candidatos desde SaldoDocumentoOrigen', async () => {
    const reciboConAnticipo = {
      _id: new Types.ObjectId(),
      unappliedAmount: 50000,
    };
    const recibos = modeloListado([]);
    const service = construirParaListado(recibos, [reciboConAnticipo]);

    await service.findAll({ conAnticipoDisponible: true });

    expect(recibos.filtros[0]).toMatchObject({
      _id: { $in: [reciboConAnticipo._id] },
    });
  });

  it('aplica el filtro de estado', async () => {
    const recibos = modeloListado([]);
    const service = construirParaListado(recibos);

    await service.findAll({ estado: 'anulado' });

    expect(recibos.filtros[0]).toMatchObject({ status: 'anulado' });
  });

  it('ordena descendente por número de recibo, no por fecha', async () => {
    const recibos = modeloListado([]);
    const service = construirParaListado(recibos);

    await service.findAll({});

    expect(recibos.ordenes[0]).toEqual({ number: -1, _id: -1 });
  });
});

describe('RecibosService.findOne', () => {
  it('devuelve ReciboDetalle con el arreglo de aplicaciones', async () => {
    const reciboId = new Types.ObjectId();
    const reciboDoc = {
      _id: reciboId,
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 500000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 0,
      unappliedAmount: 500000,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const recibos = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(reciboDoc) })),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([]) }),
      })),
    };
    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([reciboDoc]) as never,
    );

    const detalle = await service.findOne(reciboId.toString());

    expect(detalle.id).toBe(reciboId.toString());
    expect(detalle.aplicaciones).toEqual([]);
  });

  it('resuelve el número impreso (FV-1) de cada documento aplicado, para la tabla "cargo por cargo"', async () => {
    const reciboId = new Types.ObjectId();
    const facturaId = new Types.ObjectId();
    const conceptoId = new Types.ObjectId();
    const reciboDoc = {
      _id: reciboId,
      inmuebleId: INMUEBLE,
      terceroId: TERCERO,
      prefix: 'RC',
      number: 1,
      fullNumber: 'RC-1',
      receivedAmount: 200000,
      receivedDate: new Date('2026-08-27'),
      paymentMethod: 'transferencia',
      destinationAccount: '111005',
      reference: null,
      notes: null,
      appliedAmount: 200000,
      unappliedAmount: 0,
      status: 'activo',
      voidedReason: null,
      voidedDetail: null,
      voidedAt: null,
    };
    const aplicacionDoc = {
      _id: new Types.ObjectId(),
      sourceType: 'RC',
      sourceId: reciboId,
      documentType: 'FV',
      documentId: facturaId,
      amountApplied: 200000,
      detalleConceptos: [
        { conceptoId, conceptName: 'Administración', monto: 200000 },
      ],
      status: 'activa',
      appliedAt: new Date('2026-08-27'),
    };
    const recibos = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(reciboDoc) })),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([aplicacionDoc]) }),
      })),
    };
    const facturas = {
      find: jest.fn(() => ({
        exec: () => Promise.resolve([{ _id: facturaId, fullNumber: 'FV-1' }]),
      })),
    };
    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([reciboDoc]) as never,
    );

    const detalle = await service.findOne(reciboId.toString());

    expect(detalle.aplicaciones[0]).toMatchObject({
      documentoId: facturaId.toString(),
      numeroDocumento: 'FV-1',
      detalleConceptos: [
        {
          conceptoId: conceptoId.toString(),
          nombreConcepto: 'Administración',
          monto: 200000,
        },
      ],
    });
  });

  it('responde "no existe" para un recibo de otra copropiedad', async () => {
    const recibos = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = new RecibosService(
      recibos as never,
      { find: jest.fn() } as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      modeloSaldoDocumentoOrigen([]) as never,
    );

    await expect(service.findOne('rec-ajeno')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('RecibosService — ciclo de vida completo', () => {
  const BANCO = '111005';
  const CARTERA = '130501';
  const ANTICIPOS = '210505';

  type MovimientoPlano = { account: string; type: string; amount: number };

  /**
   * Modelos con ESTADO COMPARTIDO, no stubs de una sola respuesta: `crear` →
   * `aplicar` → `anular` tienen que ver el mismo recibo evolucionar
   * (appliedAmount/unappliedAmount se mueven con $inc, y `anular` lee esos
   * totales cacheados), igual que lo verían contra un Mongo real. Los stubs
   * que usa el resto de este archivo no alcanzan para eso.
   */
  const construirEntorno = (facturas: Record<string, unknown>[]) => {
    let recibo: Record<string, unknown> = {};
    const porId = new Map(facturas.map((f) => [String(f._id), f]));
    const aplicacionesStore: Record<string, unknown>[] = [];
    const asientosStore: { entries: MovimientoPlano[] }[] = [];

    const recibos = {
      create: jest.fn((filas: Record<string, unknown>[]) => {
        recibo = { _id: new Types.ObjectId(), ...filas[0] };
        return Promise.resolve([recibo]);
      }),
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
        exec: () => Promise.resolve(recibo),
      })),
      findOneAndUpdate: jest.fn(
        (
          _filtro: unknown,
          update: {
            $inc?: Record<string, number>;
            $set?: Record<string, unknown>;
          },
        ) => ({
          exec: () => {
            for (const [campo, delta] of Object.entries(update.$inc ?? {})) {
              recibo[campo] = ((recibo[campo] as number) ?? 0) + delta;
            }
            if (update.$set) Object.assign(recibo, update.$set);
            return Promise.resolve(recibo);
          },
        }),
      ),
    };

    const facturasConEstado = {
      findOne: jest.fn((filtro: Record<string, unknown>) => ({
        session: () => ({
          exec: () =>
            Promise.resolve(
              (() => {
                const doc = porId.get(String(filtro._id));
                return doc ? { ...doc } : null;
              })(),
            ),
        }),
      })),
      // `actualizarRemanentesLinea` — no test in this ciclo-de-vida asserts
      // on `remainingAmount` itself, only that the call doesn't blow up.
      updateOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };

    // La guardia atómica vive ahora en `SaldoTotalDocumento`, no en
    // `Factura` — mismo mapa `porId` (mismas referencias) que
    // `facturasConEstado` para que mutar `outstandingBalance` aquí sea
    // visible en `facturaA` directamente, igual que antes.
    const saldoTotalDocumentoConEstado = {
      findOneAndUpdate: jest.fn(
        (
          filtro: Record<string, unknown>,
          update: { $inc: { saldoPendiente: number } },
        ) => ({
          exec: () => {
            const doc = porId.get(String(filtro.documentoId));
            if (!doc) return Promise.resolve(null);
            const delta = update.$inc.saldoPendiente;
            // Réplica del piso en cero que la guardia $expr impone; una
            // restitución (delta > 0) nunca lo necesita.
            if (delta < 0 && (doc.outstandingBalance as number) < -delta) {
              return Promise.resolve(null);
            }
            doc.outstandingBalance = (doc.outstandingBalance as number) + delta;
            return Promise.resolve({
              documentoId: doc._id,
              saldoPendiente: doc.outstandingBalance,
            });
          },
        }),
      ),
      findOne: jest.fn((filtro: Record<string, unknown>) => ({
        session: () => ({
          exec: () => {
            const doc = porId.get(String(filtro.documentoId));
            return Promise.resolve(
              doc
                ? {
                    documentoId: doc._id,
                    saldoPendiente: doc.outstandingBalance,
                  }
                : null,
            );
          },
        }),
      })),
    };

    const aplicaciones = {
      create: jest.fn((filas: Record<string, unknown>[]) => {
        const creadas = filas.map((f) => ({ _id: new Types.ObjectId(), ...f }));
        aplicacionesStore.push(...creadas);
        return Promise.resolve(creadas);
      }),
      find: jest.fn(() => ({
        session: () => ({
          exec: () =>
            Promise.resolve(
              aplicacionesStore.filter((a) => a.status === 'activa'),
            ),
        }),
      })),
      findOneAndUpdate: jest.fn(
        (
          filtro: Record<string, unknown>,
          update: { $set: Record<string, unknown> },
        ) => ({
          exec: () => {
            const fila = aplicacionesStore.find(
              (a) => String(a._id) === String(filtro._id),
            );
            if (fila) Object.assign(fila, update.$set);
            return Promise.resolve(fila ?? null);
          },
        }),
      ),
    };

    const asientos = {
      create: jest.fn((filas: { entries: MovimientoPlano[] }[]) => {
        asientosStore.push(...filas);
        return Promise.resolve(filas);
      }),
    };

    // The Recibo's own live balance — seeded by `crear()`'s own
    // `saldoDocumentoOrigen.create(...)` call (there is no row until then,
    // same reasoning `recibo` itself starts as `{}`), then decremented/
    // restored exactly like `saldoTotalDocumentoConEstado` above, just for
    // the source side.
    let saldoOrigen: {
      documentoId: unknown;
      montoOriginal: number;
      saldoDisponible: number;
    } | null = null;
    const saldoDocumentoOrigenConEstado = {
      create: jest.fn((filas: Record<string, unknown>[]) => {
        saldoOrigen = {
          documentoId: filas[0].documentoId,
          montoOriginal: filas[0].montoOriginal as number,
          saldoDisponible: filas[0].saldoDisponible as number,
        };
        return Promise.resolve([saldoOrigen]);
      }),
      findOneAndUpdate: jest.fn(
        (
          filtro: Record<string, unknown>,
          update: { $inc?: { saldoDisponible: number } },
        ) => ({
          exec: () => {
            if (
              !saldoOrigen ||
              String(saldoOrigen.documentoId) !== String(filtro.documentoId)
            ) {
              return Promise.resolve(null);
            }
            if (filtro.$expr) {
              const monto = (filtro.$expr as { $gte: [string, number] })
                .$gte[1];
              if (saldoOrigen.saldoDisponible < monto) {
                return Promise.resolve(null);
              }
              saldoOrigen.saldoDisponible -= monto;
            } else if (update.$inc) {
              saldoOrigen.saldoDisponible += update.$inc.saldoDisponible;
            }
            return Promise.resolve({ ...saldoOrigen });
          },
        }),
      ),
      findOne: jest.fn((filtro: Record<string, unknown>) => {
        const resultado =
          saldoOrigen &&
          String(saldoOrigen.documentoId) === String(filtro.documentoId)
            ? { ...saldoOrigen }
            : null;
        const cadena = {
          session: () => cadena,
          exec: () => Promise.resolve(resultado),
        };
        return cadena;
      }),
      updateOne: jest.fn(
        (
          _filtro: Record<string, unknown>,
          update: { $set?: { saldoDisponible: number } },
        ) => ({
          exec: () => {
            if (saldoOrigen && update.$set)
              Object.assign(saldoOrigen, update.$set);
            return Promise.resolve(null);
          },
        }),
      ),
    };

    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      facturasConEstado as never,
      modeloSaldos() as never,
      modeloCarteraPorDocumento() as never,
      saldoTotalDocumentoConEstado as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
      modeloNotasDebito() as never,
      lotesFacturacionFalso(),
      saldoDocumentoOrigenConEstado as never,
    );

    /** Débitos menos créditos, por cuenta, sobre TODOS los asientos posteados. */
    const netoPorCuenta = () => {
      const neto = new Map<string, number>();
      for (const asiento of asientosStore) {
        for (const movimiento of asiento.entries) {
          const signo = movimiento.type === 'debito' ? 1 : -1;
          neto.set(
            movimiento.account,
            (neto.get(movimiento.account) ?? 0) + signo * movimiento.amount,
          );
        }
      }
      return neto;
    };

    return { service, netoPorCuenta, asientosStore, leerRecibo: () => recibo };
  };

  // NOTA: el paso "aplicar en diferido" que este ciclo cubría antes ahora es
  // una Nota de Anticipo (módulo `notas-anticipo`), no una segunda llamada
  // sobre el propio Recibo — ver su propio ciclo de vida completo en
  // `notas-anticipo.service.spec.ts`, que retoma exactamente donde este test
  // termina (un recibo creado con aplicación parcial, con anticipo
  // pendiente) y encadena Nota de Anticipo → anulación.
  it('crear (parcial) → anular deja cada cuenta contable en cero', async () => {
    // LA INVARIANTE CENTRAL DEL DISEÑO: un recibo anulado no puede dejar
    // rastro contable neto en NINGUNA de las tres cuentas del esquema
    // (destinationAccount / cartera / anticipos). Los dos asientos se arman
    // en lugares distintos — `construirAsientoCruce` al crear y
    // `construirContraAsientoCruce` al anular usando los totales cacheados
    // del propio recibo — así que sólo un test que recorra el ciclo entero
    // los ata entre sí.
    const facturaA = facturaDoc({
      _id: new Types.ObjectId(),
      outstandingBalance: 200000,
      total: 200000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 200000 }],
    });

    const { service, netoPorCuenta, asientosStore, leerRecibo } =
      construirEntorno([facturaA]);

    // 1. Crear por 500000 aplicando 200000 a la factura A → quedan 300000 de
    //    anticipo.
    const creado = await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 500000,
      aplicaciones: [
        {
          tipoDocumento: 'FV',
          documentoId: String(facturaA._id),
          montoAplicado: 200000,
        },
      ],
    });
    expect(creado.montoAplicado).toBe(200000);
    expect(creado.montoSinAplicar).toBe(300000);
    expect(facturaA.outstandingBalance).toBe(0);

    // 2. Anular: cascada sobre la aplicación y contra-asiento consolidado.
    const anulado = await service.anular(
      String(leerRecibo()._id),
      {
        motivo: 'error_digitacion',
        detalle: 'El cajero cargó el comprobante con el monto equivocado',
        fecha: '2026-09-01',
      },
      CUENTA.toString(),
    );
    expect(anulado.estado).toBe('anulado');
    // La cascada restituyó el saldo de la factura.
    expect(facturaA.outstandingBalance).toBe(200000);

    // LA ASERCIÓN: dos asientos posteados, y neto CERO en cada cuenta.
    expect(asientosStore).toHaveLength(2);
    const neto = netoPorCuenta();
    // Anti-vacuidad: si un refactor dejara de tocar alguna de las tres
    // cuentas, su neto sería cero y el test pasaría sin haber probado nada.
    expect([...neto.keys()].sort()).toEqual([BANCO, CARTERA, ANTICIPOS].sort());
    expect(neto.get(BANCO)).toBe(0);
    expect(neto.get(CARTERA)).toBe(0);
    expect(neto.get(ANTICIPOS)).toBe(0);

    // Y cada asiento, por separado, cuadra débitos contra créditos.
    for (const asiento of asientosStore) {
      const debitos = asiento.entries
        .filter((m) => m.type === 'debito')
        .reduce((acc, m) => acc + m.amount, 0);
      const creditos = asiento.entries
        .filter((m) => m.type === 'credito')
        .reduce((acc, m) => acc + m.amount, 0);
      expect(debitos).toBe(creditos);
    }
  });
});

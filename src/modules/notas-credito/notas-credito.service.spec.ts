import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { NotasCreditoService } from './notas-credito.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const CONCEPTO = new Types.ObjectId();

/** Runs `fn` synchronously — no real transaction, matching how this whole
 *  repo's tests stub Mongoose (see recibos.service.spec.ts's own header). */
const sesionFalsa = () => ({
  withTransaction: async (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(async () => undefined),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(async () => session) }) as never;

const tenantQueDevuelve = (id: Types.ObjectId): TenantContextService =>
  ({ resolveCoPropertyId: () => id }) as unknown as TenantContextService;

const numeracionQueEntrega = (completo: string): NumeracionService =>
  ({
    siguienteDocumento: jest.fn(() =>
      Promise.resolve({ prefijo: 'NC', numero: 1, completo }),
    ),
  }) as unknown as NumeracionService;

/** No open Lote in any test here — the guard always passes. No consolidated
 *  Lote either, by default — `obtenerUltimoConsolidado` returning `null`
 *  means "nothing to validate the note's own `fecha` period against", same
 *  default `RecibosService.crear()`'s own spec uses for the identical check
 *  on `fechaRecibo`. Tests exercising the period-match validation pass their
 *  own `lotes` override. */
const lotesFacturacionFalso = (ultimoConsolidado: unknown = null) =>
  ({
    exigirSinLoteAbierto: jest.fn(() => Promise.resolve(undefined)),
    obtenerUltimoConsolidado: jest.fn(() => Promise.resolve(ultimoConsolidado)),
  }) as never;

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  terceroId: TERCERO,
  status: 'emitida',
  fullNumber: 'FV-1',
  outstandingBalance: 200000,
  total: 200000,
  lines: [{ conceptoId: CONCEPTO, totalAmount: 200000 }],
  ...over,
});

const modeloFacturas = (factura: Record<string, unknown>) => ({
  findOne: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(factura) }),
  })),
  // Used by `findOne()`'s batch `numerosPorDocumento` resolution — never by
  // `crear()`/`aplicar()`, which only ever read one Factura at a time via
  // `findOne`/`findOneAndUpdate` above.
  find: jest.fn(() => ({ exec: () => Promise.resolve([factura]) })),
  findOneAndUpdate: jest.fn((filtro: Record<string, unknown>) => ({
    exec: () => {
      const expr = filtro.$expr as { $gte: [string, number] } | undefined;
      const monto = expr?.$gte?.[1];
      const saldo = factura.outstandingBalance as number;
      if (typeof monto === 'number' && saldo < monto) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        ...factura,
        outstandingBalance: monto === undefined ? saldo : saldo - monto,
      });
    },
  })),
});

const modeloNotasCredito = (creada: Record<string, unknown>) => ({
  create: jest.fn(() => Promise.resolve([creada])),
  findOne: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(creada) }),
  })),
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(creada) })),
});

const modeloSaldos = () => ({
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
});

const modeloAplicaciones = () => ({
  create: jest.fn((filas: Record<string, unknown>[]) =>
    Promise.resolve(filas.map((f, i) => ({ _id: `apl-${i}`, ...f }))),
  ),
});

const modeloAsientos = () => ({ create: jest.fn(() => Promise.resolve([{}])) });

const modeloCopropiedades = () => ({
  findById: jest.fn(() => ({
    session: () => ({
      exec: () =>
        Promise.resolve({
          receivablesAccount: '130501',
          advancesAccount: '210505',
          creditNotesAccount: '413595',
        }),
    }),
  })),
});

const construirServicio = (opts: {
  notaCreada: Record<string, unknown>;
  factura?: Record<string, unknown>;
  saldos?: { findOneAndUpdate: jest.Mock };
  copropiedades?: { findById: jest.Mock };
  cuentasContables?: Record<string, unknown>[];
  inmueble?: Record<string, unknown> | null;
  /** Same default as `lotesFacturacionFalso()`'s own: `null` means "never
   *  consolidated", so `crear()`'s period-match check on `dto.fecha` is a
   *  no-op — mirrors `recibos.service.spec.ts`'s identical override. */
  ultimoLoteConsolidado?: unknown;
}) => {
  const session = sesionFalsa();
  const notasCredito = modeloNotasCredito(opts.notaCreada);
  const factura = opts.factura ?? facturaDoc();
  const facturas = modeloFacturas(factura);
  const saldos = opts.saldos ?? modeloSaldos();
  const aplicaciones = modeloAplicaciones();
  const asientos = modeloAsientos();
  const copropiedades = opts.copropiedades ?? modeloCopropiedades();
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

  const service = new NotasCreditoService(
    notasCredito as never,
    aplicaciones as never,
    facturas as never,
    saldos as never,
    asientos as never,
    copropiedades as never,
    tenantQueDevuelve(COP),
    numeracionQueEntrega('NC-1'),
    conexionCon(session),
    lotesFacturacionFalso(opts.ultimoLoteConsolidado ?? null),
    cuentasContables as never,
    inmuebles as never,
  );

  return {
    service,
    notasCredito,
    facturas,
    saldos,
    aplicaciones,
    asientos,
    copropiedades,
  };
};

/**
 * Full-field fixture for a persisted NotaCredito — mirrors
 * `recibos.service.spec.ts`'s own `reciboCreado()` fixture. Required by any
 * test that expects `crear()` to reach `toNotaCredito()` (the mapper needs
 * every schema field); tests that expect an exception BEFORE that point can
 * keep using a minimal `{}` or `{ _id, ... }` object, same precedent.
 */
const notaCreditoCreada = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  inmuebleId: INMUEBLE,
  terceroId: TERCERO,
  facturaId: new Types.ObjectId(),
  issueDate: new Date('2026-01-15'),
  prefix: 'NC',
  number: 1,
  fullNumber: 'NC-1',
  reason: 'error_facturacion',
  totalAmount: 200000,
  distribution: [{ conceptoId: CONCEPTO, amount: 200000 }],
  appliedAmount: 0,
  unappliedAmount: 200000,
  notes: null,
  status: 'activo',
  voidedReason: null,
  voidedDetail: null,
  voidedAt: null,
  ...over,
});

const dtoBase = (over: Record<string, unknown> = {}) => ({
  codigo: 'NC',
  inmuebleId: INMUEBLE.toString(),
  facturaId: new Types.ObjectId().toString(),
  fecha: '2026-01-15',
  motivo: 'error_facturacion' as const,
  montoTotal: 200000,
  distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 200000 }],
  ...over,
});

describe('NotasCreditoService.crear', () => {
  it('contra una factura con saldo suficiente, aplica en su totalidad y no deja anticipo', async () => {
    const notaCreada = notaCreditoCreada();
    const { service, aplicaciones, notasCredito } = construirServicio({
      notaCreada,
    });

    await service.crear('acc-1', dtoBase());

    expect(aplicaciones.create).toHaveBeenCalledTimes(1);
    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0]).toMatchObject({
      sourceType: 'NC',
      documentType: 'FV',
      amountApplied: 200000,
    });
    // Persisted for printing (Nota Crédito's own PDF, styled after Recibo's
    // — needs the same per-concepto breakdown a Recibo application already
    // carries). Never reconstructable after the fact otherwise: this is the
    // only point `dto.distribucion` scaled against `montoAAplicar` exists.
    expect(filas[0].detalleConceptos).toEqual([
      { conceptoId: CONCEPTO, conceptName: 'Concepto', monto: 200000 },
    ]);
    expect(notasCredito.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({}),
      { $inc: { appliedAmount: 200000, unappliedAmount: -200000 } },
      expect.objectContaining({}),
    );
  });

  it('agrega tercero/centroCosto/flujoCaja cuando cuentasContables está disponible', async () => {
    const notaCreada = notaCreditoCreada();
    const { service, asientos } = construirServicio({
      notaCreada,
      copropiedades: {
        findById: jest.fn(() => ({
          session: () => ({
            exec: () =>
              Promise.resolve({
                receivablesAccount: '130501',
                advancesAccount: '210505',
                creditNotesAccount: '413595',
                defaultCostCentre: 'CC-01',
                cashFlowCode: 'FC-OPER',
              }),
          }),
        })),
      },
      cuentasContables: [
        {
          code: '413595',
          requiresTercero: true,
          profitCenter: true,
          destinationCenter: false,
          cashFlow: false,
        },
      ],
      inmueble: { code: '1304' },
    });

    await service.crear('acc-1', dtoBase());

    const [[fila]] = (asientos.create as jest.Mock).mock.calls;
    const entries = fila[0].entries as Array<{
      account: string;
      tercero?: string | null;
      centroCosto?: string | null;
    }>;
    const devoluciones = entries.find((e) => e.account === '413595');
    expect(devoluciones?.tercero).toBe('1304');
    expect(devoluciones?.centroCosto).toBe('CC-01');
  });

  it('acredita la cuenta propia del concepto cuando la línea de la factura ancla la trae configurada', async () => {
    const factura = facturaDoc({
      lines: [
        {
          conceptoId: CONCEPTO,
          totalAmount: 200000,
          accountingReceivableAccount: '130599',
        },
      ],
    });
    const notaCreada = notaCreditoCreada();
    const { service, asientos } = construirServicio({ notaCreada, factura });

    await service.crear('acc-1', dtoBase());

    const [[fila]] = (asientos.create as jest.Mock).mock.calls;
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    const creditos = entries.filter((m) => m.type === 'credito');
    // La cuenta propia del concepto (130599), NO la cuenta plana de cartera
    // de la copropiedad (130501) — aplicación total, sin anticipo.
    expect(creditos).toEqual([
      {
        account: '130599',
        type: 'credito',
        amount: 200000,
        description: expect.any(String),
      },
    ]);
  });

  it('cuando montoTotal excede el saldo de la factura ancla, aplica lo que cabe y el resto queda como anticipo', async () => {
    const factura = facturaDoc({
      outstandingBalance: 120000,
      total: 300000,
      lines: [{ conceptoId: CONCEPTO, totalAmount: 300000 }],
    });
    const notaCreada = notaCreditoCreada({
      totalAmount: 300000,
      unappliedAmount: 300000,
      distribution: [{ conceptoId: CONCEPTO, amount: 300000 }],
    });
    const { service, aplicaciones } = construirServicio({
      notaCreada,
      factura,
    });

    await service.crear(
      'acc-1',
      dtoBase({
        montoTotal: 300000,
        distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 300000 }],
      }),
    );

    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0].amountApplied).toBe(120000);
  });

  it('no aplica nada, y no crea AplicacionCartera, cuando la factura ancla ya tiene saldo cero', async () => {
    const factura = facturaDoc({ outstandingBalance: 0 });
    const notaCreada = notaCreditoCreada();
    const { service, aplicaciones } = construirServicio({
      notaCreada,
      factura,
    });

    await service.crear('acc-1', dtoBase());

    expect(aplicaciones.create).not.toHaveBeenCalled();
  });

  it('rechaza cuando la distribución no suma exacto al monto total, sin llegar a numerar', async () => {
    const numeracion = numeracionQueEntrega('NC-1');
    const { facturas } = construirServicio({ notaCreada: {} });
    // A fresh instance wired with a spied NumeracionService, so this test can
    // assert numbering never runs when distribution validation fails first.
    const servicioEspiado = new NotasCreditoService(
      modeloNotasCredito({}) as never,
      modeloAplicaciones() as never,
      facturas as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracion,
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await expect(
      servicioEspiado.crear(
        'acc-1',
        dtoBase({
          distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 100000 }],
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(numeracion.siguienteDocumento).not.toHaveBeenCalled();
  });

  it('rechaza cuando dto.inmuebleId no coincide con factura.inmuebleId — no debe permitir emparejar una unidad con la factura de otra', async () => {
    const otroInmueble = new Types.ObjectId();
    const factura = facturaDoc({ inmuebleId: otroInmueble });
    const { service } = construirServicio({ notaCreada: {}, factura });

    await expect(
      service.crear('acc-1', dtoBase({ inmuebleId: INMUEBLE.toString() })),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza una nota crédito contra una factura ya anulada', async () => {
    const factura = facturaDoc({ status: 'anulada' });
    const { service } = construirServicio({ notaCreada: {}, factura });

    await expect(service.crear('acc-1', dtoBase())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rechaza cuando la factura ancla no existe bajo este tenant', async () => {
    const { service, facturas } = construirServicio({ notaCreada: {} });
    facturas.findOne = jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(null) }),
    })) as never;

    await expect(service.crear('acc-1', dtoBase())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('descuenta SaldoCartera según la distribución elegida por el usuario, NO el split proporcional de las líneas de la factura ancla', async () => {
    const conceptoP = new Types.ObjectId();
    const conceptoQ = new Types.ObjectId();
    // Las líneas de la factura son 50%/50% (300000/300000 sobre un total de
    // 600000) — si el reparto fuera proporcional al aplicar 400000, tocaría
    // 200000/200000. La distribución elegida por el usuario es 250000/150000
    // (dentro del tope de cada concepto, validarDistribucionNotaCredito lo
    // permite). Si `crear()` usara `ajustarSaldosCartera` (proporcional) en
    // lugar de `ajustarSaldosCarteraPorDistribucion`, este test detectaría
    // la regresión.
    const factura = facturaDoc({
      outstandingBalance: 400000,
      total: 600000,
      lines: [
        { conceptoId: conceptoP, totalAmount: 300000 },
        { conceptoId: conceptoQ, totalAmount: 300000 },
      ],
    });
    const notaCreada = notaCreditoCreada({
      totalAmount: 400000,
      unappliedAmount: 0,
      appliedAmount: 400000,
      distribution: [
        { conceptoId: conceptoP, amount: 250000 },
        { conceptoId: conceptoQ, amount: 150000 },
      ],
    });
    const llamadasSaldos: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadasSaldos.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };
    const { service } = construirServicio({ notaCreada, factura, saldos });

    await service.crear(
      'acc-1',
      dtoBase({
        montoTotal: 400000,
        distribucion: [
          { conceptoId: conceptoP.toString(), monto: 250000 },
          { conceptoId: conceptoQ.toString(), monto: 150000 },
        ],
      }),
    );

    expect(llamadasSaldos).toHaveLength(2);
    const extraerMonto = (conceptoId: Types.ObjectId) => {
      const llamada = llamadasSaldos.find(([f]) =>
        (f.conceptoId as Types.ObjectId).equals(conceptoId),
      );
      const pipeline = llamada![1] as [
        { $set: { balance: { $max: [number, { $add: [string, number] }] } } },
      ];
      return pipeline[0].$set.balance.$max[1].$add[1];
    };

    expect(extraerMonto(conceptoP)).toBe(-250000);
    expect(extraerMonto(conceptoQ)).toBe(-150000);
  });

  it('postea el asiento de creación debitando cuentaDevoluciones', async () => {
    const notaCreada = notaCreditoCreada();
    const { service, asientos } = construirServicio({ notaCreada });

    await service.crear('acc-1', dtoBase());

    const [[creado]] = (asientos.create as jest.Mock).mock.calls;
    const [entrada] = creado;
    expect(entrada.notaCreditoId).toEqual(notaCreada._id);
    expect(entrada.entries[0]).toMatchObject({
      account: '413595',
      type: 'debito',
    });
  });

  it('debita la cuenta de ingreso PROPIA de cada concepto (accountingIncomeAccount de la factura ancla) — nunca una sola cuentaDevoluciones para todo', async () => {
    // Reportado en producción: el PDF salía con "Sin cuenta asignada" en el
    // débito porque copropiedad.creditNotesAccount no estaba configurada —
    // pero además, aun configurada, una sola cuenta para TODA la nota es
    // incorrecto: debe reversar el ingreso de cada concepto en la MISMA
    // cuenta que se acreditó al facturarlo (ConceptoCobro.cuentaCreditoId,
    // congelada como FacturaLinea.accountingIncomeAccount).
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const factura = facturaDoc({
      outstandingBalance: 130000,
      total: 130000,
      lines: [
        {
          conceptoId: conceptoAdmin,
          totalAmount: 100000,
          accountingIncomeAccount: '413501',
        },
        {
          conceptoId: conceptoMora,
          totalAmount: 30000,
          accountingIncomeAccount: '413502',
        },
      ],
    });
    const { service, asientos } = construirServicio({
      notaCreada: notaCreditoCreada({ totalAmount: 130000 }),
      factura,
    });

    await service.crear(
      'acc-1',
      dtoBase({
        montoTotal: 130000,
        distribucion: [
          { conceptoId: conceptoAdmin.toString(), monto: 100000 },
          { conceptoId: conceptoMora.toString(), monto: 30000 },
        ],
      }),
    );

    const [[creado]] = (asientos.create as jest.Mock).mock.calls;
    const [entrada] = creado as [{ entries: Record<string, unknown>[] }];
    const debitos = entrada.entries.filter((e) => e.type === 'debito');
    expect(debitos).toEqual([
      expect.objectContaining({ account: '413501', amount: 100000 }),
      expect.objectContaining({ account: '413502', amount: 30000 }),
    ]);
  });
});

describe('NotasCreditoService.crear — fecha de la nota', () => {
  it('guarda dto.fecha como issueDate del documento creado', async () => {
    const { service, notasCredito } = construirServicio({
      notaCreada: notaCreditoCreada(),
    });

    await service.crear('acc-1', dtoBase({ fecha: '2026-01-20' }));

    const [filas] = notasCredito.create.mock.calls[0] as unknown as [
      Record<string, unknown>[],
    ];
    expect(filas[0]).toMatchObject({ issueDate: new Date('2026-01-20') });
  });

  it('rechaza una fecha de un mes distinto al del último lote consolidado', async () => {
    const { service, notasCredito, asientos } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: { billingDate: new Date('2026-08-01') },
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2026-07-15' })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(notasCredito.create).not.toHaveBeenCalled();
    expect(asientos.create).not.toHaveBeenCalled();
  });

  it('deja pasar una fecha del mismo mes y año del último lote consolidado', async () => {
    const { service, asientos } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: { billingDate: new Date('2026-08-01') },
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2026-08-27' })),
    ).resolves.toBeDefined();
    expect(asientos.create).toHaveBeenCalledTimes(1);
  });

  it('no valida nada cuando la copropiedad nunca ha consolidado un lote', async () => {
    const { service } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: null,
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2020-01-01' })),
    ).resolves.toBeDefined();
  });

  it('un lote facturado el día 1 del mes no corre el período un mes hacia atrás (mismo bug real de Recibos)', async () => {
    // Ver `periodoCalendarioDe`'s own docblock (common/contabilidad/
    // periodo-calendario.util.ts) y el test gemelo en recibos.service.spec.ts.
    const { service, asientos } = construirServicio({
      notaCreada: notaCreditoCreada(),
      ultimoLoteConsolidado: { billingDate: new Date('2026-08-01') },
    });

    await expect(
      service.crear('acc-1', dtoBase({ fecha: '2026-08-31' })),
    ).resolves.toBeDefined();
    expect(asientos.create).toHaveBeenCalledTimes(1);
  });
});

const notaActivaDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  // `facturaId`/`distribution` were missing from the brief's own fixture —
  // harmless for the pre-existing `aplicar()` tests below (they never touch
  // `toNotaCredito`), but `anular()` (Task 8) always maps its final document
  // through `toNotaCredito`, which does `doc.facturaId.toString()` and
  // `doc.distribution.map(...)` unconditionally. Without these two fields
  // that throws a TypeError instead of returning the mapped contract. Added
  // additively — no existing assertion touches either field.
  facturaId: new Types.ObjectId(),
  distribution: [],
  fullNumber: 'NC-1',
  totalAmount: 200000,
  appliedAmount: 120000,
  unappliedAmount: 80000,
  status: 'activo',
  // NotaCredito has no declared business date field of its own —
  // `createdAt` is its issue date, read by `toAplicacionCartera` via a cast
  // (see `notas-credito.service.ts`'s own `fechaNota`).
  createdAt: new Date('2026-08-15'),
  ...over,
});

describe('NotasCreditoService.aplicar', () => {
  it('aplica manualmente contra otra factura del mismo inmueble y descuenta unappliedAmount', async () => {
    const nota = notaActivaDoc();
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $inc?: Record<string, number> }) => ({
          exec: () => {
            if (update?.$inc) {
              nota.appliedAmount += update.$inc.appliedAmount ?? 0;
              nota.unappliedAmount += update.$inc.unappliedAmount ?? 0;
            }
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const otraFactura = facturaDoc({
      outstandingBalance: 80000,
      inmuebleId: INMUEBLE,
    });
    const facturas = modeloFacturas(otraFactura);
    const aplicaciones = modeloAplicaciones();
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    const resultado = await service.aplicar(
      nota._id.toString(),
      {
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: otraFactura._id.toString(),
            montoAplicado: 80000,
          },
        ],
      },
      'acc-1',
    );

    expect(resultado.aplicadas).toHaveLength(1);
    expect(resultado.errores).toEqual([]);
    expect(aplicaciones.create).toHaveBeenCalledTimes(1);
    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0]).toMatchObject({ sourceType: 'NC', sourceId: nota._id });
    // Same reasoning as `crear()`'s own assertion: needed for the PDF's
    // débito/crédito table, and only reconstructable right here — this is a
    // DEFERRED application (`aplicarManual`), so it must capture
    // `ajustarSaldosCartera`'s own return, not `dto.distribucion`.
    expect(filas[0].detalleConceptos).toEqual([
      { conceptoId: CONCEPTO, conceptName: 'Concepto', monto: 80000 },
    ]);
  });

  it('al aplicar contra OTRA factura, sigue usando el split proporcional de esa factura (ajustarSaldosCartera, sin cambios) — nunca la distribución original de la NC', async () => {
    // `distribution` de la nota es deliberadamente irrelevante para esta
    // aplicación — pertenece únicamente a la factura ancla de `crear()`
    // (design §5/§6). Si `aplicar()` empezara a usar
    // `ajustarSaldosCarteraPorDistribucion` por error, este test lo
    // detectaría: el monto no calzaría con el split 75/25 de la OTRA
    // factura.
    const nota = notaActivaDoc({
      distribution: [{ conceptoId: CONCEPTO, amount: 999999 }],
    });
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(
        (_f: unknown, update: { $inc?: Record<string, number> }) => ({
          exec: () => {
            if (update?.$inc) {
              nota.appliedAmount += update.$inc.appliedAmount ?? 0;
              nota.unappliedAmount += update.$inc.unappliedAmount ?? 0;
            }
            return Promise.resolve(null);
          },
        }),
      ),
    };
    const conceptoR = new Types.ObjectId();
    const conceptoS = new Types.ObjectId();
    const otraFactura = facturaDoc({
      outstandingBalance: 80000,
      inmuebleId: INMUEBLE,
      total: 80000,
      lines: [
        { conceptoId: conceptoR, totalAmount: 60000 },
        { conceptoId: conceptoS, totalAmount: 20000 },
      ],
    });
    const facturas = modeloFacturas(otraFactura);
    const aplicaciones = modeloAplicaciones();
    const llamadasSaldos: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadasSaldos.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      saldos as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await service.aplicar(
      nota._id.toString(),
      {
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: otraFactura._id.toString(),
            montoAplicado: 80000,
          },
        ],
      },
      'acc-1',
    );

    expect(llamadasSaldos).toHaveLength(2);
    const extraerMonto = (conceptoId: Types.ObjectId) => {
      const llamada = llamadasSaldos.find(([f]) =>
        (f.conceptoId as Types.ObjectId).equals(conceptoId),
      );
      const pipeline = llamada![1] as [
        { $set: { balance: { $max: [number, { $add: [string, number] }] } } },
      ];
      return pipeline[0].$set.balance.$max[1].$add[1];
    };

    // 75%/25% de 80000 según las líneas de la OTRA factura.
    expect(extraerMonto(conceptoR)).toBe(-60000);
    expect(extraerMonto(conceptoS)).toBe(-20000);
  });

  it('rechaza aplicar manual y automático a la vez', async () => {
    const { service } = construirServicio({ notaCreada: notaActivaDoc() });

    // NOTE: the brief's own fixture used `aplicaciones: []` here, but an
    // empty array has `.length === 0` — falsy — so the guard
    // `dto.aplicaciones?.length && dto.aplicacionAutomatica` (mirrored
    // verbatim from `RecibosService.aplicar()`) never fires, and the
    // request silently falls through to the FIFO branch instead of being
    // rejected, throwing a TypeError from an unmocked `facturas.find()`
    // rather than the intended BadRequestException. Fixed by giving
    // `aplicaciones` an actual entry, matching the test's own intent (a
    // manual request combined with `aplicacionAutomatica: true`). The
    // assertion itself is untouched.
    await expect(
      service.aplicar(
        'nc-1',
        {
          aplicaciones: [
            {
              tipoDocumento: 'FV',
              documentoId: new Types.ObjectId().toString(),
              montoAplicado: 1000,
            },
          ],
          aplicacionAutomatica: true,
        },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza cuando no se pide ni manual ni automático', async () => {
    const { service } = construirServicio({ notaCreada: notaActivaDoc() });

    await expect(service.aplicar('nc-1', {}, 'acc-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rechaza aplicar sobre una nota crédito anulada', async () => {
    const nota = notaActivaDoc({ status: 'anulado' });
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await expect(
      service.aplicar(
        nota._id.toString(),
        { aplicacionAutomatica: true },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza cuando la nota crédito no existe bajo este tenant', async () => {
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(null) }),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await expect(
      service.aplicar('nc-ajena', { aplicacionAutomatica: true }, 'acc-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('NotasCreditoService.anular', () => {
  it('revierte cada AplicacionCartera activa (sourceType NC) y restaura el outstandingBalance de cada factura afectada', async () => {
    const facturaId = new Types.ObjectId();
    const nota = notaActivaDoc({
      appliedAmount: 120000,
      unappliedAmount: 80000,
      totalAmount: 200000,
    });
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentId: facturaId,
      amountApplied: 120000,
      status: 'activa',
    };
    const facturaRestaurada = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 200000,
      lines: [],
    };
    const facturas = {
      // Resolves `desgloseOrigen`'s per-concepto débito accounts — `null`
      // here just means the reversal falls back to `cuentaDevoluciones`,
      // which this test doesn't assert on.
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(null) }),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(facturaRestaurada),
      })),
    };
    const notasCredito = {
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
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([aplicacionActiva]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    const resultado = await service.anular(
      nota._id.toString(),
      {
        motivo: 'error_facturacion',
        detalle: 'Nota crédito emitida por error, se anula',
      },
      'acc-1',
    );

    expect(facturas.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: facturaId, coPropertyId: COP },
      { $inc: { outstandingBalance: 120000 } },
      { new: true, session: expect.anything() },
    );
    expect(resultado.estado).toBe('anulado');
    expect(resultado.montoAplicado).toBe(0);
    expect(resultado.montoSinAplicar).toBe(0);
  });

  it('reversa el débito por la cuenta de ingreso PROPIA de cada concepto (nota.distribution + accountingIncomeAccount de la factura ancla) — nunca cuentaDevoluciones sola', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const nota = notaActivaDoc({
      facturaId,
      distribution: [
        { conceptoId: conceptoAdmin, amount: 100000 },
        { conceptoId: conceptoMora, amount: 30000 },
      ],
      appliedAmount: 130000,
      unappliedAmount: 0,
      totalAmount: 130000,
    });
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentId: facturaId,
      amountApplied: 130000,
      status: 'activa',
    };
    const facturaAncla = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 130000,
      lines: [
        {
          conceptoId: conceptoAdmin,
          totalAmount: 100000,
          accountingIncomeAccount: '413501',
        },
        {
          conceptoId: conceptoMora,
          totalAmount: 30000,
          accountingIncomeAccount: '413502',
        },
      ],
    };
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(facturaAncla) }),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(facturaAncla),
      })),
    };
    const notasCredito = {
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
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([aplicacionActiva]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await service.anular(
      nota._id.toString(),
      {
        motivo: 'otro',
        detalle: 'Anula la nota crédito por error de digitación',
      },
      'acc-1',
    );

    const [[creado]] = (asientos.create as jest.Mock).mock.calls;
    const [entrada] = creado as [{ entries: Record<string, unknown>[] }];
    const creditos = entrada.entries.filter((e) => e.type === 'credito');
    expect(creditos).toEqual([
      expect.objectContaining({ account: '413501', amount: 100000 }),
      expect.objectContaining({ account: '413502', amount: 30000 }),
    ]);
  });

  // Mirrors `recibos.service.spec.ts`'s
  // 'restaura el saldo aunque la factura afectada ya esté anulada por otra
  // vía' — added per code-review finding on this task (test-coverage gap
  // only; `anular()`'s `if (factura)` guard already handles this correctly).
  it('revierte la aplicación aunque la factura afectada ya esté anulada por otra vía (no rompe, es contabilidad inofensiva)', async () => {
    const facturaId = new Types.ObjectId();
    const nota = notaActivaDoc({
      appliedAmount: 120000,
      unappliedAmount: 80000,
      totalAmount: 200000,
    });
    const aplicacionActiva = {
      _id: new Types.ObjectId(),
      documentId: facturaId,
      amountApplied: 120000,
      status: 'activa',
    };

    // La factura ya no existe bajo esas condiciones (anulada por otra vía) —
    // el findOneAndUpdate devuelve null, y el cascade sigue sin lanzar.
    const facturas = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(null) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const notasCredito = {
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
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([aplicacionActiva]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await expect(
      service.anular(
        nota._id.toString(),
        { motivo: 'otro', detalle: 'La factura ya fue anulada por otra vía' },
        'acc-1',
      ),
    ).resolves.toBeDefined();

    // La AplicacionCartera se marca revertida de todos modos — la reversión
    // del cruce es incondicional (design §6).
    expect(aplicaciones.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('con una aplicación ANCLA (de crear()) y una NO ancla (de un aplicar() previo contra otra factura), reversa cada una con la matemática que la originó — nunca al revés', async () => {
    const facturaAncla = new Types.ObjectId();
    const facturaOtra = new Types.ObjectId();
    const conceptoX = new Types.ObjectId();
    const conceptoY = new Types.ObjectId();
    const conceptoZ = new Types.ObjectId();

    const nota = notaActivaDoc({
      facturaId: facturaAncla,
      distribution: [
        { conceptoId: conceptoX, amount: 150000 },
        { conceptoId: conceptoY, amount: 50000 },
      ],
      appliedAmount: 280000,
      unappliedAmount: 0,
      totalAmount: 280000,
    });

    // La ancla: creada en crear() contra `facturaAncla`, aplicando el total
    // de la distribución (200000 = 150000 + 50000).
    const aplicacionAncla = {
      _id: new Types.ObjectId(),
      documentId: facturaAncla,
      amountApplied: 200000,
      status: 'activa',
    };
    // La NO ancla: creada más tarde vía aplicar() contra OTRA factura, sin
    // relación con `nota.distribution`.
    const aplicacionOtra = {
      _id: new Types.ObjectId(),
      documentId: facturaOtra,
      amountApplied: 80000,
      status: 'activa',
    };

    const facturaAnclaRestaurada = {
      _id: facturaAncla,
      inmuebleId: INMUEBLE,
      total: 200000,
      lines: [{ conceptoId: conceptoX, totalAmount: 200000 }],
    };
    const facturaOtraRestaurada = {
      _id: facturaOtra,
      inmuebleId: INMUEBLE,
      total: 80000,
      outstandingBalance: 80000, // restaurada por completo: 0 → 80000
      lines: [{ conceptoId: conceptoZ, totalAmount: 80000 }],
    };

    const facturas = {
      // Resolves `desgloseOrigen`'s per-concepto débito accounts from the
      // anchor Factura's own `lines` — no `accountingIncomeAccount` set on
      // them here, so the reversal falls back to `cuentaDevoluciones`, which
      // this test doesn't assert on (it only checks the SaldoCartera math).
      findOne: jest.fn(() => ({
        session: () => ({
          exec: () => Promise.resolve(facturaAnclaRestaurada),
        }),
      })),
      findOneAndUpdate: jest.fn((filtro: Record<string, unknown>) => ({
        exec: () => {
          const id = filtro._id as Types.ObjectId;
          if (id.equals(facturaAncla)) {
            return Promise.resolve(facturaAnclaRestaurada);
          }
          if (id.equals(facturaOtra)) {
            return Promise.resolve(facturaOtraRestaurada);
          }
          return Promise.resolve(null);
        },
      })),
    };
    const notasCredito = {
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
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({
          exec: () => Promise.resolve([aplicacionAncla, aplicacionOtra]),
        }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const llamadasSaldos: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadasSaldos.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      saldos as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await service.anular(
      nota._id.toString(),
      { motivo: 'otro', detalle: 'Anula ambas aplicaciones, ancla y no-ancla' },
      'acc-1',
    );

    const extraerMonto = (conceptoId: Types.ObjectId) => {
      const llamada = llamadasSaldos.find(([f]) =>
        (f.conceptoId as Types.ObjectId).equals(conceptoId),
      );
      const pipeline = llamada![1] as [
        { $set: { balance: { $max: [number, { $add: [string, number] }] } } },
      ];
      return pipeline[0].$set.balance.$max[1].$add[1];
    };

    // La ANCLA reversa por DISTRIBUCIÓN: una llamada por cada línea de
    // `nota.distribution`, cada una restaurando exactamente su propio monto.
    expect(
      llamadasSaldos.filter(([f]) => f.inmuebleId === INMUEBLE),
    ).toHaveLength(3);
    expect(extraerMonto(conceptoX)).toBe(150000);
    expect(extraerMonto(conceptoY)).toBe(50000);

    // La NO-ANCLA reversa por el split PROPORCIONAL de SU PROPIA factura —
    // una sola línea (conceptoZ), por el amountApplied completo (80000) —
    // ajustarSaldosCartera sin cambios.
    expect(extraerMonto(conceptoZ)).toBe(80000);
  });

  it('postea SIEMPRE el contra-asiento, acreditando cuentaDevoluciones por el montoTotal completo', async () => {
    const nota = notaActivaDoc({
      appliedAmount: 200000,
      unappliedAmount: 0,
      totalAmount: 200000,
    });
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve([]) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const asientos = modeloAsientos();
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await service.anular(
      nota._id.toString(),
      { motivo: 'otro', detalle: 'Detalle de más de veinte caracteres' },
      'acc-1',
    );

    // Cast to `jest.Mock` — same fix the `crear` tests above already needed
    // (line ~260): `modeloAsientos()`'s `create: jest.fn(() => ...)` has no
    // declared parameters, so TS infers `mock.calls` as `[][]`, and
    // destructuring a call's args as `[entrada]` fails to compile
    // (`Tuple type '[]' of length '0' has no element at index '0'`) even
    // though it runs fine under ts-jest. Fixed additively — the assertion
    // itself is unchanged.
    const [[creado]] = (asientos.create as jest.Mock).mock.calls;
    const [entrada] = creado;
    expect(
      entrada.entries.find((m: { type: string }) => m.type === 'credito'),
    ).toMatchObject({
      account: '413595',
      amount: 200000,
    });
  });

  it('rechaza anular una nota crédito ya anulada', async () => {
    const nota = notaActivaDoc({ status: 'anulado' });
    const notasCredito = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(nota) }),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await expect(
      service.anular(
        nota._id.toString(),
        { motivo: 'otro', detalle: 'Detalle de más de veinte caracteres' },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('NotasCreditoService.findAll', () => {
  it('filtra por copropiedad activa, inmueble, estado y rango de fecha (issueDate, con fallback a createdAt para notas sin issueDate)', async () => {
    const documentos: unknown[] = [];
    const notasCredito = {
      find: jest.fn((filtro: Record<string, unknown>) => {
        (notasCredito as unknown as { filtroUsado: unknown }).filtroUsado =
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
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await service.findAll({
      inmuebleId: INMUEBLE.toString(),
      estado: 'activo',
      desde: '2026-08-01',
      hasta: '2026-08-31',
    });

    const rango = {
      $gte: new Date('2026-08-01'),
      $lte: new Date('2026-08-31'),
    };
    expect(
      (notasCredito as unknown as { filtroUsado: Record<string, unknown> })
        .filtroUsado,
    ).toEqual({
      coPropertyId: COP,
      inmuebleId: INMUEBLE.toString(),
      status: 'activo',
      $or: [{ issueDate: rango }, { issueDate: null, createdAt: rango }],
    });
  });

  it('aplica conAnticipoDisponible como unappliedAmount > 0', async () => {
    const documentos: unknown[] = [];
    const notasCredito = {
      find: jest.fn((filtro: Record<string, unknown>) => {
        (notasCredito as unknown as { filtroUsado: unknown }).filtroUsado =
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
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await service.findAll({ conAnticipoDisponible: true });

    expect(
      (notasCredito as unknown as { filtroUsado: Record<string, unknown> })
        .filtroUsado,
    ).toMatchObject({ unappliedAmount: { $gt: 0 } });
  });
});

describe('NotasCreditoService.findOne', () => {
  it('devuelve NotaCreditoDetalle con el arreglo de aplicaciones', async () => {
    const nota = notaActivaDoc();
    const notasCredito = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(nota) })),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([]) }),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    const detalle = await service.findOne(nota._id.toString());

    expect(detalle.id).toBe(nota._id.toString());
    expect(detalle.aplicaciones).toEqual([]);
  });

  it('resuelve numeroFactura de la ancla y de cada aplicación, aun cuando aplicó contra OTRA factura', async () => {
    // El excedente de una nota crédito puede aplicarse después contra
    // cualquier factura abierta del inmueble, no solo la ancla — igual que
    // el anticipo de un Recibo (ver `aplicarManual`/`aplicarFifo`). El mapa
    // de números debe resolver ambas, no solo `nota.facturaId`.
    const facturaAncla = new Types.ObjectId();
    const facturaOtra = new Types.ObjectId();
    const nota = notaActivaDoc({ facturaId: facturaAncla });
    const notasCredito = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(nota) })),
    };
    const aplicacion = {
      _id: new Types.ObjectId(),
      sourceType: 'NC',
      sourceId: nota._id,
      documentType: 'FV',
      documentId: facturaOtra,
      amountApplied: 50000,
      status: 'activa',
      appliedAt: new Date('2026-08-30'),
    };
    const aplicaciones = {
      find: jest.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([aplicacion]) }),
      })),
    };
    const facturas = {
      find: jest.fn(() => ({
        exec: () =>
          Promise.resolve([
            { _id: facturaAncla, fullNumber: 'FV-0001' },
            { _id: facturaOtra, fullNumber: 'FV-0042' },
          ]),
      })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      aplicaciones as never,
      facturas as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    const detalle = await service.findOne(nota._id.toString());

    expect(detalle.numeroFactura).toBe('FV-0001');
    expect(detalle.aplicaciones[0]).toMatchObject({
      documentoId: facturaOtra.toString(),
      numeroDocumento: 'FV-0042',
    });
  });

  it('lanza NotFoundException cuando la nota crédito no existe bajo este tenant', async () => {
    const notasCredito = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = new NotasCreditoService(
      notasCredito as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('NC-1'),
      conexionCon(sesionFalsa()),
      lotesFacturacionFalso(),
    );

    await expect(service.findOne('nc-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

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
}) => {
  const session = sesionFalsa();
  const notasCredito = modeloNotasCredito(opts.notaCreada);
  const factura = opts.factura ?? facturaDoc();
  const facturas = modeloFacturas(factura);
  const saldos = opts.saldos ?? modeloSaldos();
  const aplicaciones = modeloAplicaciones();
  const asientos = modeloAsientos();
  const copropiedades = modeloCopropiedades();

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
  );

  return { service, notasCredito, facturas, saldos, aplicaciones, asientos, copropiedades };
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
  inmuebleId: INMUEBLE.toString(),
  facturaId: new Types.ObjectId().toString(),
  motivo: 'error_facturacion' as const,
  montoTotal: 200000,
  distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 200000 }],
  ...over,
});

describe('NotasCreditoService.crear', () => {
  it('contra una factura con saldo suficiente, aplica en su totalidad y no deja anticipo', async () => {
    const notaCreada = notaCreditoCreada();
    const { service, aplicaciones, notasCredito } = construirServicio({ notaCreada });

    await service.crear('acc-1', dtoBase());

    expect(aplicaciones.create).toHaveBeenCalledTimes(1);
    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0]).toMatchObject({
      sourceType: 'NC',
      documentType: 'FV',
      amountApplied: 200000,
    });
    expect(notasCredito.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({}),
      { $inc: { appliedAmount: 200000, unappliedAmount: -200000 } },
      expect.objectContaining({}),
    );
  });

  it('cuando montoTotal excede el saldo de la factura ancla, aplica lo que cabe y el resto queda como anticipo', async () => {
    const factura = facturaDoc({ outstandingBalance: 120000, total: 300000, lines: [{ conceptoId: CONCEPTO, totalAmount: 300000 }] });
    const notaCreada = notaCreditoCreada({
      totalAmount: 300000,
      unappliedAmount: 300000,
      distribution: [{ conceptoId: CONCEPTO, amount: 300000 }],
    });
    const { service, aplicaciones } = construirServicio({ notaCreada, factura });

    await service.crear('acc-1', dtoBase({ montoTotal: 300000, distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 300000 }] }));

    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0].amountApplied).toBe(120000);
  });

  it('no aplica nada, y no crea AplicacionCartera, cuando la factura ancla ya tiene saldo cero', async () => {
    const factura = facturaDoc({ outstandingBalance: 0 });
    const notaCreada = notaCreditoCreada();
    const { service, aplicaciones } = construirServicio({ notaCreada, factura });

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
    );

    await expect(
      servicioEspiado.crear(
        'acc-1',
        dtoBase({ distribucion: [{ conceptoId: CONCEPTO.toString(), monto: 100000 }] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(numeracion.siguienteDocumento).not.toHaveBeenCalled();
  });

  it('rechaza una nota crédito contra una factura ya anulada', async () => {
    const factura = facturaDoc({ status: 'anulada' });
    const { service } = construirServicio({ notaCreada: {}, factura });

    await expect(service.crear('acc-1', dtoBase())).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza cuando la factura ancla no existe bajo este tenant', async () => {
    const { service, facturas } = construirServicio({ notaCreada: {} });
    facturas.findOne = jest.fn(() => ({ session: () => ({ exec: () => Promise.resolve(null) }) })) as never;

    await expect(service.crear('acc-1', dtoBase())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('postea el asiento de creación debitando cuentaDevoluciones', async () => {
    const notaCreada = notaCreditoCreada();
    const { service, asientos } = construirServicio({ notaCreada });

    await service.crear('acc-1', dtoBase());

    const [[creado]] = (asientos.create as jest.Mock).mock.calls;
    const [entrada] = creado;
    expect(entrada.notaCreditoId).toEqual(notaCreada._id);
    expect(entrada.entries[0]).toMatchObject({ account: '413595', type: 'debito' });
  });
});

const notaActivaDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  fullNumber: 'NC-1',
  totalAmount: 200000,
  appliedAmount: 120000,
  unappliedAmount: 80000,
  status: 'activo',
  ...over,
});

describe('NotasCreditoService.aplicar', () => {
  it('aplica manualmente contra otra factura del mismo inmueble y descuenta unappliedAmount', async () => {
    const nota = notaActivaDoc();
    const notasCredito = {
      findOne: jest.fn(() => ({ session: () => ({ exec: () => Promise.resolve(nota) }) })),
      findOneAndUpdate: jest.fn((_f: unknown, update: { $inc?: Record<string, number> }) => ({
        exec: () => {
          if (update?.$inc) {
            nota.appliedAmount += update.$inc.appliedAmount ?? 0;
            nota.unappliedAmount += update.$inc.unappliedAmount ?? 0;
          }
          return Promise.resolve(null);
        },
      })),
    };
    const otraFactura = facturaDoc({ outstandingBalance: 80000, inmuebleId: INMUEBLE });
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
    );

    const resultado = await service.aplicar(
      nota._id.toString(),
      { aplicaciones: [{ tipoDocumento: 'FV', documentoId: (otraFactura._id as Types.ObjectId).toString(), montoAplicado: 80000 }] },
      'acc-1',
    );

    expect(resultado.aplicadas).toHaveLength(1);
    expect(resultado.errores).toEqual([]);
    expect(aplicaciones.create).toHaveBeenCalledTimes(1);
    const [[filas]] = aplicaciones.create.mock.calls;
    expect(filas[0]).toMatchObject({ sourceType: 'NC', sourceId: nota._id });
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
            { tipoDocumento: 'FV', documentoId: new Types.ObjectId().toString(), montoAplicado: 1000 },
          ],
          aplicacionAutomatica: true,
        },
        'acc-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza cuando no se pide ni manual ni automático', async () => {
    const { service } = construirServicio({ notaCreada: notaActivaDoc() });

    await expect(service.aplicar('nc-1', {}, 'acc-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza aplicar sobre una nota crédito anulada', async () => {
    const nota = notaActivaDoc({ status: 'anulado' });
    const notasCredito = {
      findOne: jest.fn(() => ({ session: () => ({ exec: () => Promise.resolve(nota) }) })),
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
    );

    await expect(
      service.aplicar(nota._id.toString(), { aplicacionAutomatica: true }, 'acc-1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza cuando la nota crédito no existe bajo este tenant', async () => {
    const notasCredito = {
      findOne: jest.fn(() => ({ session: () => ({ exec: () => Promise.resolve(null) }) })),
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
    );

    await expect(
      service.aplicar('nc-ajena', { aplicacionAutomatica: true }, 'acc-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

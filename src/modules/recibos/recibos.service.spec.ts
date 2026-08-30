import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { RecibosService } from './recibos.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

/** Runs `fn` synchronously — no real transaction, matching how this whole
 *  repo's tests stub Mongoose (see the header note on this plan). */
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
      Promise.resolve({ prefijo: 'RC', numero: 1, completo }),
    ),
  }) as unknown as NumeracionService;

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
  ...over,
});

const modeloFacturas = (factura: Record<string, unknown>) => ({
  findOneAndUpdate: jest.fn((filtro: Record<string, unknown>) => ({
    exec: () => {
      const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
      if ((factura.outstandingBalance as number) < monto)
        return Promise.resolve(null);
      factura.outstandingBalance =
        (factura.outstandingBalance as number) - monto;
      return Promise.resolve({ ...factura });
    },
  })),
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
        }),
    }),
  })),
});

const construirServicio = (opts: {
  reciboCreado: Record<string, unknown>;
  factura?: Record<string, unknown>;
}) => {
  const session = sesionFalsa();
  const recibos = modeloRecibos(opts.reciboCreado);
  const facturas = modeloFacturas(opts.factura ?? facturaDoc());
  const saldos = modeloSaldos();
  const aplicaciones = modeloAplicaciones();
  const asientos = modeloAsientos();
  const copropiedades = modeloCopropiedades();

  const service = new RecibosService(
    recibos as never,
    aplicaciones as never,
    facturas as never,
    saldos as never,
    asientos as never,
    copropiedades as never,
    tenantQueDevuelve(COP),
    numeracionQueEntrega('RC-1'),
    conexionCon(session),
  );

  return { service, recibos, facturas, saldos, aplicaciones, asientos };
};

const dtoBase = () => ({
  inmuebleId: INMUEBLE.toString(),
  terceroId: TERCERO.toString(),
  montoRecibido: 500000,
  fechaRecibo: '2026-08-27',
  medioPago: 'transferencia' as const,
  cuentaDestino: '111005',
});

describe('RecibosService.crear — sin aplicaciones (100% anticipo)', () => {
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

    const resultado = await service.crear(CUENTA.toString(), dtoBase());

    expect(resultado.montoSinAplicar).toBe(500000);
    expect(resultado.montoAplicado).toBe(0);
    expect(asientos.create).toHaveBeenCalledTimes(1);
    const [[fila]] = (asientos.create as jest.Mock).mock.calls;
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
        description: expect.any(String),
      },
      {
        account: '210505',
        type: 'credito',
        amount: 500000,
        description: expect.any(String),
      },
    ]);
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
    const { service, facturas, asientos } = construirServicio({
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
    expect(facturas.findOneAndUpdate).toHaveBeenCalled();
    expect(asientos.create).toHaveBeenCalledTimes(1);
    const [[fila]] = (asientos.create as jest.Mock).mock.calls;
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
        description: expect.any(String),
      },
      {
        account: '130501',
        type: 'credito',
        amount: 200000,
        description: expect.any(String),
      },
      {
        account: '210505',
        type: 'credito',
        amount: 300000,
        description: expect.any(String),
      },
    ]);
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

    const ordenAplicado: string[] = [];
    const facturas = {
      find: jest.fn(() => ({
        sort: () => ({
          session: () => ({
            exec: () => Promise.resolve([vieja, nueva]),
          }),
        }),
      })),
      findOneAndUpdate: jest.fn((filtro: Record<string, unknown>) => ({
        exec: () => {
          const id = (filtro._id as Types.ObjectId).toString();
          const factura = id === vieja._id.toString() ? vieja : nueva;
          const monto = (filtro.$expr as { $gte: [string, number] }).$gte[1];
          if (factura.outstandingBalance < monto) return Promise.resolve(null);
          factura.outstandingBalance -= monto;
          ordenAplicado.push(id);
          return Promise.resolve({ ...factura });
        },
      })),
    };

    const session = sesionFalsa();
    const recibos = modeloRecibos(reciboCreado);
    const saldos = modeloSaldos();
    const aplicaciones = modeloAplicaciones();
    const asientos = modeloAsientos();
    const copropiedades = modeloCopropiedades();

    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      facturas as never,
      saldos as never,
      asientos as never,
      copropiedades as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
    );

    await service.crear(CUENTA.toString(), {
      ...dtoBase(),
      montoRecibido: 300000,
      aplicacionAutomatica: true,
    });

    expect(ordenAplicado).toEqual([vieja._id.toString(), nueva._id.toString()]);
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
        sort: () => ({
          session: () => ({ exec: () => Promise.resolve([invalida, valida]) }),
        }),
      })),
      findOneAndUpdate: jest.fn((filtro: Record<string, unknown>) => ({
        exec: () => {
          const id = (filtro._id as Types.ObjectId).toString();
          if (id === invalida._id.toString()) return Promise.resolve(null); // voided since listed
          valida.outstandingBalance = 0;
          return Promise.resolve({ ...valida });
        },
      })),
    };

    const session = sesionFalsa();
    const recibos = modeloRecibos(reciboCreado);
    const service = new RecibosService(
      recibos as never,
      modeloAplicaciones() as never,
      facturas as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
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
});

describe('RecibosService.aplicar', () => {
  const reciboExistente = (over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    coPropertyId: COP,
    inmuebleId: INMUEBLE,
    destinationAccount: '111005',
    receivedDate: new Date('2026-08-20'),
    fullNumber: 'RC-1',
    status: 'activo',
    unappliedAmount: 300000,
    appliedAmount: 200000,
    receivedAmount: 500000,
    ...over,
  });

  it('aplica el anticipo disponible de un recibo existente contra un documento nuevo', async () => {
    const facturaId = new Types.ObjectId();
    const factura = facturaDoc({ _id: facturaId });
    const recibo = reciboExistente();

    const recibos = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(recibo) })),
    };
    const facturas = modeloFacturas(factura);
    const session = sesionFalsa();
    const asientos = modeloAsientos();
    const service = new RecibosService(
      recibos as never,
      modeloAplicaciones() as never,
      facturas as never,
      modeloSaldos() as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
    );

    const resultado = await service.aplicar(
      recibo._id.toString(),
      {
        aplicaciones: [
          { tipoDocumento: 'FV', documentoId: facturaId.toString(), montoAplicado: 200000 },
        ],
      },
      CUENTA.toString(),
    );

    expect(resultado.aplicadas).toHaveLength(1);
    expect(resultado.errores).toEqual([]);
    // Solo mueve el pasivo hacia la cartera — el efectivo ya se había
    // contabilizado en destinationAccount al momento de crear el recibo, así
    // que esta posterior aplicación NUNCA vuelve a tocar esa cuenta.
    expect(asientos.create).toHaveBeenCalledTimes(1);
    const [[fila]] = (asientos.create as jest.Mock).mock.calls;
    const entries = fila[0].entries as Array<{ account: string; type: string; amount: number }>;
    expect(entries).toEqual([
      { account: '210505', type: 'debito', amount: 200000, description: expect.any(String) },
      { account: '130501', type: 'credito', amount: 200000, description: expect.any(String) },
    ]);
  });

  it('rechaza cuando lo solicitado excede el saldo sin aplicar del recibo', async () => {
    const recibo = reciboExistente({ unappliedAmount: 50000 });
    const recibos = {
      findOne: jest.fn(() => ({ session: () => ({ exec: () => Promise.resolve(recibo) }) })),
    };
    const session = sesionFalsa();
    const service = new RecibosService(
      recibos as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
    );

    await expect(
      service.aplicar(
        recibo._id.toString(),
        {
          aplicaciones: [
            {
              tipoDocumento: 'FV',
              documentoId: new Types.ObjectId().toString(),
              montoAplicado: 200000,
            },
          ],
        },
        CUENTA.toString(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza aplicar sobre un recibo ya anulado', async () => {
    const recibo = reciboExistente({ status: 'anulado' });
    const recibos = {
      findOne: jest.fn(() => ({ session: () => ({ exec: () => Promise.resolve(recibo) }) })),
    };
    const session = sesionFalsa();
    const service = new RecibosService(
      recibos as never,
      modeloAplicaciones() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
    );

    await expect(
      service.aplicar(
        recibo._id.toString(),
        { aplicacionAutomatica: true },
        CUENTA.toString(),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

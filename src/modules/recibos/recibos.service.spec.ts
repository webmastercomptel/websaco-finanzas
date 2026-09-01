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
  /** Default: periodo abierto. Sólo el test del periodo cerrado lo pisa. */
  periodo?: PeriodoService;
  saldos?: { findOneAndUpdate: jest.Mock };
}) => {
  const session = sesionFalsa();
  const recibos = modeloRecibos(opts.reciboCreado);
  const facturas = modeloFacturas(opts.factura ?? facturaDoc());
  const saldos = opts.saldos ?? modeloSaldos();
  const aplicaciones = modeloAplicaciones();
  const asientos = modeloAsientos();
  const copropiedades = modeloCopropiedades();
  const espia = periodoEspiado();
  const periodo = opts.periodo ?? espia.periodo;
  const exigirAbierto = espia.exigirAbierto;

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
    periodo,
  );

  return {
    service,
    recibos,
    facturas,
    saldos,
    aplicaciones,
    asientos,
    periodo,
    exigirAbierto,
  };
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
      service.crear(CUENTA.toString(), dtoBase()),
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
      service.crear(CUENTA.toString(), dtoBase()),
    ).resolves.toBeDefined();
    expect(asientos.create).toHaveBeenCalledTimes(1);
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
      periodoAbierto(),
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
      periodoAbierto(),
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
        sort: () => ({
          session: () => ({ exec: () => Promise.resolve([factura]) }),
        }),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve({ ...factura, outstandingBalance: 0 }),
      })),
    };
    // El decremento pasó; el cache de cartera revienta con un error cualquiera
    // (una ValidationError de Mongoose, un fallo de red — da igual).
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
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
    );

    await expect(
      service.crear(CUENTA.toString(), {
        ...dtoBase(),
        montoRecibido: 100000,
        aplicacionAutomatica: true,
      }),
    ).rejects.toThrow('fallo inesperado en SaldoCartera');
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
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(recibo),
      })),
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
      periodoAbierto(),
    );

    const resultado = await service.aplicar(
      recibo._id.toString(),
      {
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: facturaId.toString(),
            montoAplicado: 200000,
          },
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
    const entries = fila[0].entries as Array<{
      account: string;
      type: string;
      amount: number;
    }>;
    expect(entries).toEqual([
      {
        account: '210505',
        type: 'debito',
        amount: 200000,
        description: expect.any(String),
      },
      {
        account: '130501',
        type: 'credito',
        amount: 200000,
        description: expect.any(String),
      },
    ]);
  });

  it('rechaza cuando lo solicitado excede el saldo sin aplicar del recibo', async () => {
    const recibo = reciboExistente({ unappliedAmount: 50000 });
    const recibos = {
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
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
      periodoAbierto(),
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
      findOne: jest.fn(() => ({
        session: () => ({ exec: () => Promise.resolve(recibo) }),
      })),
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
      periodoAbierto(),
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
    };

    const facturaRestaurada = {
      _id: facturaId,
      inmuebleId: INMUEBLE,
      total: 500000,
      lines: [],
    };
    const facturas = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(facturaRestaurada),
      })),
    };
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
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
    );

    const resultado = await service.anular(
      recibo._id.toString(),
      {
        motivo: 'duplicado',
        detalle: 'Se cargó el mismo comprobante dos veces por error del cajero',
      },
      CUENTA.toString(),
    );

    expect(facturas.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: facturaId, coPropertyId: COP },
      { $inc: { outstandingBalance: 200000 } },
      expect.objectContaining({ new: true }),
    );
    expect(aplicaciones.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: aplicacionActiva._id, coPropertyId: COP },
      { $set: { status: 'revertida' } },
      expect.objectContaining({ session: expect.anything() }),
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
          voidedAt: expect.any(Date),
          // El actor de la anulación sale del caller autenticado y se escribe
          // en el MISMO $set que la transición de estado — nunca uno sin el
          // otro. Es la operación más auditada del módulo y era la única
          // mutación del módulo que no registraba quién la hizo.
          voidedBy: CUENTA.toString(),
          appliedAmount: 0,
          unappliedAmount: 0,
        },
      },
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(resultado.estado).toBe('anulado');
    expect(resultado.motivoAnulacion).toBe('duplicado');
    expect(resultado.detalleAnulacion).toBe(
      'Se cargó el mismo comprobante dos veces por error del cajero',
    );
    expect(resultado.fechaAnulacion).toEqual(expect.any(String));
    // Usa los totales CACHEADOS del recibo (appliedAmount/unappliedAmount/
    // receivedAmount), no una suma recalculada del loop de arriba — no hace
    // falta "reproducir" la historia para saber cuánto revertir.
    const [[fila]] = (asientos.create as jest.Mock).mock.calls;
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
        description: expect.any(String),
      },
      {
        account: '210505',
        type: 'debito',
        amount: 100000,
        description: expect.any(String),
      },
      {
        account: '111005',
        type: 'credito',
        amount: 300000,
        description: expect.any(String),
      },
    ]);
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
    // u otra vía) — el findOneAndUpdate devuelve null, y el cascade sigue
    // sin lanzar.
    const facturas = {
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
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
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
    );

    await expect(
      service.anular(
        recibo._id.toString(),
        {
          motivo: 'otro',
          detalle: 'La factura ya fue anulada por otra vía',
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
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(session),
      periodoAbierto(),
    );

    await expect(
      service.anular(
        recibo._id.toString(),
        {
          motivo: 'otro',
          detalle: 'Un detalle de más de veinte caracteres',
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
    const cadena = {
      sort: () => cadena,
      skip: () => cadena,
      limit: () => cadena,
      exec: () => Promise.resolve(filas),
    };
    return {
      filtros,
      find: jest.fn((f: Record<string, unknown>) => {
        filtros.push(f);
        return cadena;
      }),
      countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(total) })),
    };
  };

  const construirParaListado = (recibos: ReturnType<typeof modeloListado>) =>
    new RecibosService(
      recibos as never,
      modeloAplicacionesGenerico() as never,
      modeloFacturas(facturaDoc()) as never,
      modeloSaldos() as never,
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
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

  it('aplica conAnticipoDisponible como unappliedAmount > 0', async () => {
    const recibos = modeloListado([]);
    const service = construirParaListado(recibos);

    await service.findAll({ conAnticipoDisponible: true });

    expect(recibos.filtros[0]).toMatchObject({ unappliedAmount: { $gt: 0 } });
  });

  it('aplica el filtro de estado', async () => {
    const recibos = modeloListado([]);
    const service = construirParaListado(recibos);

    await service.findAll({ estado: 'anulado' });

    expect(recibos.filtros[0]).toMatchObject({ status: 'anulado' });
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
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
    );

    const detalle = await service.findOne(reciboId.toString());

    expect(detalle.id).toBe(reciboId.toString());
    expect(detalle.aplicaciones).toEqual([]);
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
      modeloAsientos() as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
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
      findOneAndUpdate: jest.fn(
        (
          filtro: Record<string, unknown>,
          update: { $inc: { outstandingBalance: number } },
        ) => ({
          exec: () => {
            const doc = porId.get(String(filtro._id));
            if (!doc) return Promise.resolve(null);
            const delta = update.$inc.outstandingBalance;
            // Réplica del piso en cero que `decrementarSaldoFactura` impone
            // con su $expr; una restitución (delta > 0) nunca lo necesita.
            if (delta < 0 && (doc.outstandingBalance as number) < -delta) {
              return Promise.resolve(null);
            }
            doc.outstandingBalance = (doc.outstandingBalance as number) + delta;
            return Promise.resolve({ ...doc });
          },
        }),
      ),
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

    const service = new RecibosService(
      recibos as never,
      aplicaciones as never,
      facturasConEstado as never,
      modeloSaldos() as never,
      asientos as never,
      modeloCopropiedades() as never,
      tenantQueDevuelve(COP),
      numeracionQueEntrega('RC-1'),
      conexionCon(sesionFalsa()),
      periodoAbierto(),
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

  it('crear (parcial) → aplicar (diferido) → anular deja cada cuenta contable en cero', async () => {
    // LA INVARIANTE CENTRAL DEL DISEÑO: un recibo anulado no puede dejar
    // rastro contable neto en NINGUNA de las tres cuentas del esquema
    // (destinationAccount / cartera / anticipos), sin importar por cuántas
    // aplicaciones haya pasado antes. Los tres asientos se arman en lugares
    // distintos — `construirAsientoRecibo` al crear,
    // `construirMovimientosAplicacionAnticipo` al aplicar en diferido, y
    // `construirContraAsientoRecibo` al anular usando los totales cacheados
    // del propio recibo — así que sólo un test que recorra el ciclo entero
    // los ata entre sí.
    const facturaA = facturaDoc({
      _id: new Types.ObjectId(),
      outstandingBalance: 200000,
      total: 200000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 200000 }],
    });
    const facturaB = facturaDoc({
      _id: new Types.ObjectId(),
      outstandingBalance: 100000,
      total: 100000,
      lines: [{ conceptoId: new Types.ObjectId(), totalAmount: 100000 }],
    });

    const { service, netoPorCuenta, asientosStore, leerRecibo } =
      construirEntorno([facturaA, facturaB]);

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

    // 2. Aplicar en diferido 100000 de ese anticipo contra la factura B →
    //    quedan 200000 sin aplicar.
    const aplicado = await service.aplicar(
      String(leerRecibo()._id),
      {
        aplicaciones: [
          {
            tipoDocumento: 'FV',
            documentoId: String(facturaB._id),
            montoAplicado: 100000,
          },
        ],
      },
      CUENTA.toString(),
    );
    expect(aplicado.aplicadas).toHaveLength(1);
    expect(aplicado.montoSinAplicar).toBe(200000);
    expect(facturaB.outstandingBalance).toBe(0);

    // 3. Anular todo: cascada sobre las dos aplicaciones y contra-asiento
    //    consolidado.
    const anulado = await service.anular(
      String(leerRecibo()._id),
      {
        motivo: 'error_digitacion',
        detalle: 'El cajero cargó el comprobante con el monto equivocado',
      },
      CUENTA.toString(),
    );
    expect(anulado.estado).toBe('anulado');
    // La cascada restituyó el saldo de las dos facturas.
    expect(facturaA.outstandingBalance).toBe(200000);
    expect(facturaB.outstandingBalance).toBe(100000);

    // LA ASERCIÓN: tres asientos posteados, y neto CERO en cada cuenta.
    expect(asientosStore).toHaveLength(3);
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

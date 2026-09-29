import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LoteRecibosService } from './lote-recibos.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { RecibosService } from './recibos.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId();

const tenantQueDevuelve = (id: Types.ObjectId): TenantContextService =>
  ({ resolveCoPropertyId: () => id }) as unknown as TenantContextService;

/** No-op numeración mock for the tests below that don't exercise
 *  `ejecutarAplicacion` at all (`crear`, `cargarArchivo`) — `reservarBloqueDocumentos`
 *  is only ever called from the batch-application path. */
const numeracionVacia = (): NumeracionService =>
  ({
    reservarBloqueDocumentos: jest.fn().mockResolvedValue({ numeros: [] }),
  }) as unknown as NumeracionService;

const inmuebleDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  code: '301',
  holderId: new Types.ObjectId(),
  ...over,
});

/** A hand-rolled Mongoose-document-shaped lote — mutable in place (like a
 *  real Mongoose document), with `save()`/`markModified()` no-ops that just
 *  track calls, matching this repo's own "shared-state, not one-shot
 *  stubs" discipline for services that mutate a fetched document. */
const loteDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  number: 1,
  status: 'cargado',
  creadoEn: new Date('2026-06-10T14:30:00.000Z'),
  codigo: 'RC',
  medioPago: 'transferencia',
  cuentaDestino: '111005',
  totalDigitado: 0,
  filas: [] as Record<string, unknown>[],
  generatedBy: CUENTA,
  markModified: jest.fn(),
  save: jest.fn(function (this: Record<string, unknown>) {
    return Promise.resolve(this);
  }),
  ...over,
});

/** Covers `crear()` and `cargarArchivo()` — neither touches
 *  `NumeracionService`/`Connection`/BullMQ at all, so those three
 *  constructor params get harmless stand-ins here. */
const construirServicioBasico = (opciones: {
  lote?: Record<string, unknown> | null;
  lotes?: Record<string, unknown>[];
  inmuebles?: Record<string, unknown>[];
  copropiedad?: Record<string, unknown> | null;
  recibosCreados?: Record<string, unknown>[];
  crearRecibo?: jest.Mock;
  yaHayUno?: boolean;
}) => {
  const lotesModelo = {
    exists: jest.fn(() => ({
      exec: () => Promise.resolve(opciones.yaHayUno ?? false),
    })),
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(opciones.lote ?? null),
    })),
    find: jest.fn(() => ({
      sort: () => ({ exec: () => Promise.resolve(opciones.lotes ?? []) }),
    })),
    findOneAndUpdate: jest.fn(
      (_filtro: unknown, _update: unknown, _opts?: unknown) => ({
        exec: () => Promise.resolve(opciones.lote ?? null),
      }),
    ),
    create: jest.fn((datos: Record<string, unknown>) =>
      Promise.resolve({ ...loteDoc(), ...datos }),
    ),
    deleteOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };

  const consecutivos = {
    findOneAndUpdate: jest.fn(() => ({
      exec: () => Promise.resolve({ nextNumber: 1 }),
    })),
  };

  const inmuebles = {
    find: jest.fn(() => ({
      exec: () => Promise.resolve(opciones.inmuebles ?? []),
    })),
    findOne: jest.fn((filtro: Record<string, unknown>) => ({
      exec: () =>
        Promise.resolve(
          (opciones.inmuebles ?? []).find(
            (i) => String(i._id) === String(filtro._id),
          ) ?? null,
        ),
    })),
  };

  const recibosModelo = {
    find: jest.fn(() => ({
      exec: () => Promise.resolve(opciones.recibosCreados ?? []),
    })),
  };

  const copropiedades = {
    findById: jest.fn(() => ({
      exec: () =>
        Promise.resolve(
          'copropiedad' in opciones ? opciones.copropiedad : { code: '0001' },
        ),
    })),
  };

  const recibosService = {
    crear:
      opciones.crearRecibo ??
      jest.fn(() => Promise.resolve({ id: new Types.ObjectId().toString() })),
  } as unknown as RecibosService;

  const service = new LoteRecibosService(
    lotesModelo as never,
    consecutivos as never,
    inmuebles as never,
    recibosModelo as never,
    copropiedades as never,
    tenantQueDevuelve(COP),
    recibosService,
    numeracionVacia(),
    { startSession: jest.fn() } as never, // connection — not exercised here
    undefined, // cola
    undefined, // eventosCola
  );

  return { service, lotesModelo, recibosService };
};

describe('LoteRecibosService.crear', () => {
  it('rechaza cuando ya hay un lote en curso (borrador o cargado)', async () => {
    const { service } = construirServicioBasico({ yaHayUno: true });

    await expect(
      service.crear(CUENTA.toString(), {
        codigo: 'RC',
        medioPago: 'transferencia',
        totalDigitado: 100000,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('crea el lote en estado borrador', async () => {
    const { service } = construirServicioBasico({});

    const resultado = await service.crear(CUENTA.toString(), {
      codigo: 'RC',
      medioPago: 'transferencia',
      totalDigitado: 100000,
    });

    expect(resultado.estado).toBe('borrador');
    expect(resultado.totalDigitado).toBe(100000);
  });
});

describe('LoteRecibosService.cargarArchivo', () => {
  it('resuelve inmuebleId cuando el código existe en la copropiedad activa', async () => {
    const inmueble = inmuebleDoc({ code: '301' });
    const lote = loteDoc();
    const { service, lotesModelo } = construirServicioBasico({
      lote,
      inmuebles: [inmueble],
    });

    await service.cargarArchivo('lote-1', CUENTA.toString(), {
      filas: [
        {
          inmuebleCodigo: '301',
          fechaPago: '2026-06-02',
          valorRecibido: 100000,
        },
      ],
    });

    const [, update] = lotesModelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      {
        $set: {
          filas: { inmuebleId: Types.ObjectId | null; error: string | null }[];
        };
      },
    ];
    expect(update.$set.filas[0].inmuebleId).toEqual(inmueble._id);
    expect(update.$set.filas[0].error).toBeNull();
  });

  it('marca en error una fila cuyo código de inmueble no existe', async () => {
    const lote = loteDoc();
    const { service, lotesModelo } = construirServicioBasico({
      lote,
      inmuebles: [],
    });

    await service.cargarArchivo('lote-1', CUENTA.toString(), {
      filas: [
        {
          inmuebleCodigo: '999',
          fechaPago: '2026-06-02',
          valorRecibido: 100000,
        },
      ],
    });

    const [, update] = lotesModelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: { filas: { error: string | null }[] } },
    ];
    expect(update.$set.filas[0].error).toMatch(/no existe/);
  });

  it('marca en error una fila cuyo código de copropiedad no coincide con la activa', async () => {
    const inmueble = inmuebleDoc({ code: '301' });
    const lote = loteDoc();
    const { service, lotesModelo } = construirServicioBasico({
      lote,
      inmuebles: [inmueble],
      copropiedad: { code: '0001' },
    });

    await service.cargarArchivo('lote-1', CUENTA.toString(), {
      filas: [
        {
          inmuebleCodigo: '301',
          copropiedadCodigo: '0002',
          fechaPago: '2026-06-02',
          valorRecibido: 100000,
        },
      ],
    });

    const [, update] = lotesModelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: { filas: { error: string | null }[] } },
    ];
    expect(update.$set.filas[0].error).toMatch(/no coincide/);
  });

  it('marca en error un inmueble sin titular asignado', async () => {
    const inmueble = inmuebleDoc({ code: '301', holderId: null });
    const lote = loteDoc();
    const { service, lotesModelo } = construirServicioBasico({
      lote,
      inmuebles: [inmueble],
    });

    await service.cargarArchivo('lote-1', CUENTA.toString(), {
      filas: [
        {
          inmuebleCodigo: '301',
          fechaPago: '2026-06-02',
          valorRecibido: 100000,
        },
      ],
    });

    const [, update] = lotesModelo.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: { filas: { error: string | null }[] } },
    ];
    expect(update.$set.filas[0].error).toMatch(/titular/);
  });

  it('rechaza cargar un archivo sobre un lote ya aplicado', async () => {
    const lote = loteDoc({ status: 'aplicado' });
    const { service } = construirServicioBasico({ lote });

    await expect(
      service.cargarArchivo('lote-1', CUENTA.toString(), {
        filas: [
          {
            inmuebleCodigo: '301',
            fechaPago: '2026-06-02',
            valorRecibido: 100000,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ---------------------------------------------------------------------------
// ejecutarAplicacion() / aplicar() — tanda-batched shared-transaction path
// ---------------------------------------------------------------------------

const filaBase = (over: Record<string, unknown> = {}) => ({
  inmuebleId: new Types.ObjectId(),
  inmuebleCodigo: '301',
  fechaPago: new Date('2026-06-02'),
  valorRecibido: 250000,
  reciboId: null,
  error: null,
  ...over,
});

const construirLoteDoc = (filas: ReturnType<typeof filaBase>[]) => ({
  _id: new Types.ObjectId(),
  number: 1,
  status: 'cargado',
  creadoEn: new Date('2026-06-01'),
  codigo: 'IN',
  medioPago: 'transferencia',
  cuentaDestino: null,
  totalDigitado: filas.reduce((s, f) => s + f.valorRecibido, 0),
  totalFilas: filas.reduce((s, f) => s + f.valorRecibido, 0),
  filas,
  markModified: jest.fn(),
  save: jest.fn().mockResolvedValue(undefined),
});

/** Hand-rolled Mongo session/connection mock — no real replica set involved
 *  (transactions need one; this codebase's tests never spin one up).
 *  `withTransaction` just awaits its callback once — no retry simulation,
 *  matching how `LotesFacturacionService`'s own tests mock the same shape. */
const construirConnectionMock = () => {
  const session = {
    withTransaction: jest.fn(async (fn: () => Promise<void>) => {
      await fn();
    }),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  return {
    connection: { startSession: jest.fn().mockResolvedValue(session) },
    session,
  };
};

/** Reserves sequential numbers starting at 1, matching how many rows
 *  `ejecutarAplicacion` actually asks for — real callers get real numbers,
 *  but nothing under test here asserts on the number's own value.
 *
 *  Deliberately NOT typed as `NumeracionService` — a plain object literal
 *  keeps `reservarBloqueDocumentos` a plain `jest.Mock` for assertions
 *  (`numeracion.reservarBloqueDocumentos`), instead of a class method
 *  reference that `@typescript-eslint/unbound-method` flags when torn off
 *  its receiver. Cast to `never` only at the constructor call site, same
 *  as every other hand-rolled dependency in this file. */
const numeracionQueReserva = () => ({
  reservarBloqueDocumentos: jest.fn(
    (_cop: string, _code: string, cantidad: number) =>
      Promise.resolve({
        numeros: Array.from({ length: cantidad }, (_, i) => ({
          prefijo: 'RC',
          numero: i + 1,
          completo: `RC-${i + 1}`,
        })),
      }),
  ),
});

const construirServicio = (
  loteDoc: ReturnType<typeof construirLoteDoc>,
  crearImpl: (dto: Record<string, unknown>) => Promise<{ id: string }>,
  connectionMock = construirConnectionMock(),
) => {
  const lotesModel = {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc) })),
  };
  const inmueblesModel = {
    findOne: jest.fn(() => ({
      session: () => ({
        exec: () =>
          Promise.resolve({
            _id: new Types.ObjectId(),
            holderId: new Types.ObjectId(),
          }),
      }),
    })),
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  };
  const recibosModel = {
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  };
  const recibosService = {
    prepararCreacion: jest.fn().mockResolvedValue({
      coPropertyId: COP,
      destinationAccount: 'CTA-1',
      diferenciaConfirmada: 0,
    }),
    crearEnSesion: jest.fn(
      (_session: unknown, _accountId: string, dto: Record<string, unknown>) =>
        crearImpl(dto),
    ),
  };
  const numeracion = numeracionQueReserva();

  const service = new LoteRecibosService(
    lotesModel as never,
    {} as never, // consecutivos — not exercised by ejecutarAplicacion
    inmueblesModel as never,
    recibosModel as never,
    {} as never, // copropiedades — not exercised by ejecutarAplicacion
    { resolveCoPropertyId: () => COP } as never,
    recibosService as never,
    numeracion as never,
    connectionMock.connection as never,
    undefined, // cola — no BullMQ in this test, mirrors LotesFacturacionService's own test-construction pattern
    undefined, // eventosCola
  );
  return { service, recibosService, numeracion, ...connectionMock };
};

describe('LoteRecibosService.ejecutarAplicacion', () => {
  it('crea un Recibo por cada fila elegible (vía prepararCreacion + crearEnSesion) y marca el lote como aplicado', async () => {
    const filas = [filaBase()];
    const lote = construirLoteDoc(filas);
    const { service, recibosService } = construirServicio(lote, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    const { errores } = await service.ejecutarAplicacion(
      lote._id.toString(),
      COP,
      'cuenta-1',
    );

    expect(errores).toHaveLength(0);
    expect(recibosService.prepararCreacion).toHaveBeenCalledTimes(1);
    expect(recibosService.crearEnSesion).toHaveBeenCalledTimes(1);
    expect(lote.status).toBe('aplicado');
  });

  it('reserva un bloque de números del tamaño exacto de las filas pendientes, antes de abrir ninguna tanda', async () => {
    const filas = [filaBase(), filaBase({ inmuebleCodigo: '302' })];
    const lote = construirLoteDoc(filas);
    const { service, numeracion } = construirServicio(lote, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    await service.ejecutarAplicacion(lote._id.toString(), COP, 'cuenta-1');

    expect(numeracion.reservarBloqueDocumentos).toHaveBeenCalledWith(
      COP.toString(),
      'IN',
      2,
    );
  });

  it('una tanda entera se revierte cuando UNA fila falla — el resto de esa tanda también queda en errores, ninguna persiste reciboId', async () => {
    const filas = [filaBase(), filaBase({ inmuebleCodigo: '302' })];
    const lote = construirLoteDoc(filas);
    let llamada = 0;
    const { service } = construirServicio(lote, () => {
      llamada += 1;
      if (llamada === 1) return Promise.reject(new Error('periodo cerrado'));
      return Promise.resolve({ id: new Types.ObjectId().toString() });
    });

    const { errores } = await service.ejecutarAplicacion(
      lote._id.toString(),
      COP,
      'cuenta-1',
    );

    // Both rows land in the same (only) tanda here — one throw aborts the
    // shared transaction, so BOTH rows are recorded as errored, even though
    // the second row's own crearEnSesion call would have succeeded alone.
    expect(errores).toHaveLength(2);
    expect(filas[0].reciboId).toBeNull();
    expect(filas[1].reciboId).toBeNull();
    expect(lote.status).toBe('cargado');
  });

  it('C1 — una fila que YA tuvo éxito antes de que otra fallara en la misma tanda no conserva un reciboId fantasma', async () => {
    // Row 0 succeeds (its `fila.reciboId` gets set in-memory the instant
    // `crearEnSesion` resolves), THEN row 1 fails — the whole shared
    // transaction rolls back, so row 0's Recibo was never actually
    // persisted either. Without the fix, `filas[0].reciboId` would still
    // be a real ObjectId pointing at nothing, and the lote would eventually
    // read as `aplicado` with a row whose payment was never recorded.
    const filas = [filaBase(), filaBase({ inmuebleCodigo: '302' })];
    const lote = construirLoteDoc(filas);
    let llamada = 0;
    const { service } = construirServicio(lote, () => {
      llamada += 1;
      if (llamada === 1)
        return Promise.resolve({ id: new Types.ObjectId().toString() });
      return Promise.reject(new Error('período contable cerrado'));
    });

    const { errores } = await service.ejecutarAplicacion(
      lote._id.toString(),
      COP,
      'cuenta-1',
    );

    expect(filas[0].reciboId).toBeNull();
    expect(filas[1].reciboId).toBeNull();
    expect(errores).toHaveLength(2);
    // The row that actually threw carries the real message verbatim; the
    // collateral row's message attributes the cause instead of repeating it
    // as if it had failed the same way itself.
    expect(errores[1].mensaje).toBe('período contable cerrado');
    expect(errores[0].mensaje).toMatch(/Revertida junto con la fila 2/);
  });

  it('una fila ya aplicada (reciboId presente) no se reprocesa', async () => {
    const yaAplicado = new Types.ObjectId();
    const filas = [filaBase({ reciboId: yaAplicado })];
    const lote = construirLoteDoc(filas);
    const { service, recibosService } = construirServicio(lote, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    await service.ejecutarAplicacion(lote._id.toString(), COP, 'cuenta-1');

    expect(recibosService.crearEnSesion).not.toHaveBeenCalled();
    expect(lote.status).toBe('aplicado');
  });

  it('rechaza cuando la suma de las filas no coincide con el total digitado', async () => {
    const filas = [filaBase({ valorRecibido: 100000 })];
    const lote = construirLoteDoc(filas);
    lote.totalDigitado = 999999;
    const { service } = construirServicio(lote, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    await expect(
      service.ejecutarAplicacion(lote._id.toString(), COP, 'cuenta-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('una fila que falló en un intento previo se reintenta y se aplica con éxito', async () => {
    const filas = [
      filaBase({ error: 'El período contable está cerrado' }), // del intento anterior
    ];
    const lote = construirLoteDoc(filas);
    const { service } = construirServicio(lote, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    const { errores } = await service.ejecutarAplicacion(
      lote._id.toString(),
      COP,
      'cuenta-1',
    );

    expect(errores).toHaveLength(0);
    expect(filas[0].error).toBeNull();
    expect(lote.status).toBe('aplicado');
  });

  it('cada tanda abre y cierra su propia sesión (una sesión por tanda, no una global para todo el lote)', async () => {
    const filas = [filaBase(), filaBase({ inmuebleCodigo: '302' })];
    const lote = construirLoteDoc(filas);
    const connectionMock = construirConnectionMock();
    const { service } = construirServicio(
      lote,
      () => Promise.resolve({ id: new Types.ObjectId().toString() }),
      connectionMock,
    );

    await service.ejecutarAplicacion(lote._id.toString(), COP, 'cuenta-1');

    // Both rows fit in one tanda (tanda size 20) here, so exactly one
    // session is opened and closed for this whole run.
    expect(connectionMock.connection.startSession).toHaveBeenCalledTimes(1);
    expect(connectionMock.session.endSession).toHaveBeenCalledTimes(1);
  });
});

describe('LoteRecibosService.aplicar (enqueue path)', () => {
  it('sin cola configurada, corre ejecutarAplicacion inline (test-construction fallback)', async () => {
    const filas = [filaBase()];
    const lote = construirLoteDoc(filas);
    const { service, recibosService } = construirServicio(lote, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    await service.aplicar(lote._id.toString(), 'cuenta-1');

    expect(recibosService.crearEnSesion).toHaveBeenCalledTimes(1);
  });

  it('con cola configurada, encola el trabajo y espera su resultado', async () => {
    const filas = [filaBase()];
    const lote = construirLoteDoc(filas);
    const lotesModel = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(lote) })),
    };
    const resultadoEsperado = { lote: {} as never, errores: [] };
    const trabajo = {
      waitUntilFinished: jest.fn().mockResolvedValue(resultadoEsperado),
    };
    const cola = { add: jest.fn().mockResolvedValue(trabajo) };
    const eventosCola = {};
    const { connection } = construirConnectionMock();

    const service = new LoteRecibosService(
      lotesModel as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { resolveCoPropertyId: () => COP } as never,
      { prepararCreacion: jest.fn(), crearEnSesion: jest.fn() } as never,
      numeracionQueReserva() as never,
      connection as never,
      cola as never,
      eventosCola as never,
    );

    const resultado = await service.aplicar(lote._id.toString(), 'cuenta-1');

    expect(cola.add).toHaveBeenCalledWith('aplicar', {
      loteId: lote._id.toString(),
      coPropertyId: COP.toString(),
      accountId: 'cuenta-1',
    });
    expect(trabajo.waitUntilFinished).toHaveBeenCalledWith(eventosCola);
    expect(resultado).toBe(resultadoEsperado);
  });
});

describe('LoteRecibosService.ejecutarAplicacion — división en tandas', () => {
  it('con más filas que el tamaño de una tanda, dos filas del mismo inmueble pueden terminar en tandas distintas (concurrentes entre sí)', async () => {
    // 21 rows: tanda size is 20, so this forces exactly 2 tandas. Rows 0 and
    // 20 share INMUEBLE_ID — row 0 lands in tanda 1, row 20 lands in tanda
    // 2, confirming the split is positional and does NOT group by
    // inmuebleId (the real-world condition Task 3's Review Focus note
    // relies on `session.withTransaction`'s own retry to make safe).
    const filas = Array.from({ length: 21 }, (_, i) =>
      filaBase({ inmuebleCodigo: `fila-${i}` }),
    );
    const lote = construirLoteDoc(filas);
    const connectionMock = construirConnectionMock();
    const { service } = construirServicio(
      lote,
      () => Promise.resolve({ id: new Types.ObjectId().toString() }),
      connectionMock,
    );

    await service.ejecutarAplicacion(lote._id.toString(), COP, 'cuenta-1');

    // 2 tandas → 2 sessions opened, one per tanda — the second tanda (row
    // 20 alone) is not merged into the first just because it shares an
    // inmueble with row 0.
    expect(connectionMock.connection.startSession).toHaveBeenCalledTimes(2);
  });
});

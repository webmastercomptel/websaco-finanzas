import { Types } from 'mongoose';
import { LoteRecibosService } from './lote-recibos.service';

const COPROPERTY_ID = new Types.ObjectId();
const INMUEBLE_ID = new Types.ObjectId();
const HOLDER_ID = new Types.ObjectId();

const filaBase = (over: Record<string, unknown> = {}) => ({
  inmuebleId: INMUEBLE_ID,
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
        exec: () => Promise.resolve({ _id: INMUEBLE_ID, holderId: HOLDER_ID }),
      }),
    })),
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  };
  const recibosModel = {
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  };
  const recibosService = {
    prepararCreacion: jest.fn().mockResolvedValue({
      coPropertyId: COPROPERTY_ID,
      destinationAccount: 'CTA-1',
      diferenciaConfirmada: 0,
    }),
    crearEnSesion: jest.fn(
      (_session: unknown, _accountId: string, dto: Record<string, unknown>) =>
        crearImpl(dto),
    ),
  };

  const service = new LoteRecibosService(
    lotesModel as never,
    {} as never, // consecutivos — not exercised by ejecutarAplicacion
    inmueblesModel as never,
    recibosModel as never,
    {} as never, // copropiedades — not exercised by ejecutarAplicacion
    { resolveCoPropertyId: () => COPROPERTY_ID } as never,
    recibosService as never,
    connectionMock.connection as never,
    undefined, // cola — no BullMQ in this test, mirrors LotesFacturacionService's own test-construction pattern
    undefined, // eventosCola
  );
  return { service, recibosService, ...connectionMock };
};

describe('LoteRecibosService.ejecutarAplicacion', () => {
  it('crea un Recibo por cada fila elegible (vía prepararCreacion + crearEnSesion) y marca el lote como aplicado', async () => {
    const filas = [filaBase()];
    const loteDoc = construirLoteDoc(filas);
    const { service, recibosService } = construirServicio(loteDoc, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    const { errores } = await service.ejecutarAplicacion(
      loteDoc._id.toString(),
      COPROPERTY_ID,
      'cuenta-1',
    );

    expect(errores).toHaveLength(0);
    expect(recibosService.prepararCreacion).toHaveBeenCalledTimes(1);
    expect(recibosService.crearEnSesion).toHaveBeenCalledTimes(1);
    expect(loteDoc.status).toBe('aplicado');
  });

  it('una tanda entera se revierte cuando UNA fila falla — el resto de esa tanda también queda en errores, ninguna persiste reciboId', async () => {
    const filas = [filaBase(), filaBase({ inmuebleCodigo: '302' })];
    const loteDoc = construirLoteDoc(filas);
    let llamada = 0;
    const { service } = construirServicio(loteDoc, () => {
      llamada += 1;
      if (llamada === 1) return Promise.reject(new Error('periodo cerrado'));
      return Promise.resolve({ id: new Types.ObjectId().toString() });
    });

    const { errores } = await service.ejecutarAplicacion(
      loteDoc._id.toString(),
      COPROPERTY_ID,
      'cuenta-1',
    );

    // Both rows land in the same (only) tanda here — one throw aborts the
    // shared transaction, so BOTH rows are recorded as errored, even though
    // the second row's own crearEnSesion call would have succeeded alone.
    expect(errores).toHaveLength(2);
    expect(filas[0].reciboId).toBeNull();
    expect(filas[1].reciboId).toBeNull();
    expect(loteDoc.status).toBe('cargado');
  });

  it('una fila ya aplicada (reciboId presente) no se reprocesa', async () => {
    const yaAplicado = new Types.ObjectId();
    const filas = [filaBase({ reciboId: yaAplicado })];
    const loteDoc = construirLoteDoc(filas);
    const { service, recibosService } = construirServicio(loteDoc, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    await service.ejecutarAplicacion(
      loteDoc._id.toString(),
      COPROPERTY_ID,
      'cuenta-1',
    );

    expect(recibosService.crearEnSesion).not.toHaveBeenCalled();
    expect(loteDoc.status).toBe('aplicado');
  });

  it('cada tanda abre y cierra su propia sesión (una sesión por tanda, no una global para todo el lote)', async () => {
    const filas = [filaBase(), filaBase({ inmuebleCodigo: '302' })];
    const loteDoc = construirLoteDoc(filas);
    const connectionMock = construirConnectionMock();
    const { service } = construirServicio(
      loteDoc,
      () => Promise.resolve({ id: new Types.ObjectId().toString() }),
      connectionMock,
    );

    await service.ejecutarAplicacion(
      loteDoc._id.toString(),
      COPROPERTY_ID,
      'cuenta-1',
    );

    // Both rows fit in one tanda (tanda size 20) here, so exactly one
    // session is opened and closed for this whole run.
    expect(connectionMock.connection.startSession).toHaveBeenCalledTimes(1);
    expect(connectionMock.session.endSession).toHaveBeenCalledTimes(1);
  });
});

describe('LoteRecibosService.aplicar (enqueue path)', () => {
  it('sin cola configurada, corre ejecutarAplicacion inline (test-construction fallback)', async () => {
    const filas = [filaBase()];
    const loteDoc = construirLoteDoc(filas);
    const { service, recibosService } = construirServicio(loteDoc, () =>
      Promise.resolve({ id: new Types.ObjectId().toString() }),
    );

    await service.aplicar(loteDoc._id.toString(), 'cuenta-1');

    expect(recibosService.crearEnSesion).toHaveBeenCalledTimes(1);
  });

  it('con cola configurada, encola el trabajo y espera su resultado', async () => {
    const filas = [filaBase()];
    const loteDoc = construirLoteDoc(filas);
    const lotesModel = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc) })),
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
      { resolveCoPropertyId: () => COPROPERTY_ID } as never,
      { prepararCreacion: jest.fn(), crearEnSesion: jest.fn() } as never,
      connection as never,
      cola as never,
      eventosCola as never,
    );

    const resultado = await service.aplicar(loteDoc._id.toString(), 'cuenta-1');

    expect(cola.add).toHaveBeenCalledWith('aplicar', {
      loteId: loteDoc._id.toString(),
      coPropertyId: COPROPERTY_ID.toString(),
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
    const loteDoc = construirLoteDoc(filas);
    const connectionMock = construirConnectionMock();
    const { service } = construirServicio(
      loteDoc,
      () => Promise.resolve({ id: new Types.ObjectId().toString() }),
      connectionMock,
    );

    await service.ejecutarAplicacion(
      loteDoc._id.toString(),
      COPROPERTY_ID,
      'cuenta-1',
    );

    // 2 tandas → 2 sessions opened, one per tanda — the second tanda (row
    // 20 alone) is not merged into the first just because it shares an
    // inmueble with row 0.
    expect(connectionMock.connection.startSession).toHaveBeenCalledTimes(2);
  });
});

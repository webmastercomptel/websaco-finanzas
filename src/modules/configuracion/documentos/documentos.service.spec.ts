import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { DocumentosService } from './documentos.service';

const COP = new Types.ObjectId();

/** Runs `fn` synchronously, matching this repo's established transaction-test
 *  stub (see recibos.service.spec.ts). */
const sesionFalsa = () => ({
  withTransaction: (fn: () => Promise<unknown>) => fn(),
  endSession: jest.fn(() => Promise.resolve(undefined)),
});

const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
  ({ startSession: jest.fn(() => Promise.resolve(session)) }) as never;

const tenantQueDevuelve = () => ({ resolveCoPropertyId: () => COP }) as never;

const consecutivoDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  documentType: 'RC',
  prefix: 'RC',
  nextNumber: 10,
  displayName: 'Recibo de Caja',
  accountingVoucherCode: '02',
  electronicNumber: null,
  ...over,
});

const resolucionDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  resolutionNumber: 'RES-001',
  prefix: 'CONJ-2026',
  rangeFrom: 1,
  rangeTo: 1000,
  nextNumber: 5,
  validFrom: new Date('2026-01-01'),
  validUntil: null,
  status: 'active',
  displayName: 'Cobro Expensas Comunes',
  accountingVoucherCode: '01',
  electronicNumber: null,
  ...over,
});

/** A `find/findOne/findOneAndUpdate` chain mock that supports both a plain
 *  `.exec()` and `.session(s).exec()`/`.lean().exec()` — the shapes
 *  documentos.service.ts actually calls across its different methods. */
const modeloConsecutivos = (filas: Record<string, unknown>[]) => {
  const cadena = (data: unknown): Record<string, unknown> => ({
    session: () => cadena(data),
    sort: () => cadena(data),
    exec: () => Promise.resolve(data),
  });
  return {
    find: jest.fn(() => cadena(filas)),
    findOne: jest.fn(() => cadena(filas[0] ?? null)),
    findOneAndUpdate: jest.fn(
      (_f: unknown, update: Record<string, unknown>) => {
        const set = (update as { $set: Record<string, unknown> }).$set;
        return cadena({ ...(filas[0] ?? {}), ...set });
      },
    ),
  };
};

const modeloResoluciones = (activa: Record<string, unknown> | null) => {
  const cadena = (data: unknown) => ({
    session: () => cadena(data),
    exec: () => Promise.resolve(data),
  });
  const escrituras: Record<string, unknown>[] = [];
  return {
    escrituras,
    findOne: jest.fn(() => cadena(activa)),
    updateOne: jest.fn(() => cadena({ acknowledged: true })) as jest.Mock,
    create: jest.fn((docs: Record<string, unknown>[]) => {
      escrituras.push(...docs);
      return Promise.resolve(
        docs.map((d) => ({ ...d, _id: new Types.ObjectId() })),
      );
    }),
    findByIdAndUpdate: jest.fn(
      (_id: unknown, update: Record<string, unknown>) => {
        const set = (update as { $set: Record<string, unknown> }).$set;
        return cadena(activa ? { ...activa, ...set } : null);
      },
    ),
  };
};

/** A per-document-type model exposing `find(...).lean().exec()`, the shape
 *  `getHighestIssuedNumber` uses. */
const modeloDocumentos = (docs: { fullNumber: string }[]) => ({
  find: jest.fn(() => ({
    lean: () => ({ exec: () => Promise.resolve(docs) }),
  })),
});

const construir = (opts: {
  consecutivos?: ReturnType<typeof modeloConsecutivos>;
  resoluciones?: ReturnType<typeof modeloResoluciones>;
  recibos?: ReturnType<typeof modeloDocumentos>;
  session?: ReturnType<typeof sesionFalsa>;
}) => {
  const session = opts.session ?? sesionFalsa();
  return new DocumentosService(
    (opts.consecutivos ?? modeloConsecutivos([consecutivoDoc()])) as never,
    (opts.resoluciones ?? modeloResoluciones(null)) as never,
    (opts.recibos ?? modeloDocumentos([])) as never,
    modeloDocumentos([]) as never, // notasCredito
    modeloDocumentos([]) as never, // notasDebito
    modeloDocumentos([]) as never, // notasContables
    tenantQueDevuelve(),
    conexionCon(session),
  );
};

describe('DocumentosService.findAll', () => {
  it('devuelve los consecutivos y la resolución activa juntos', async () => {
    const service = construir({
      consecutivos: modeloConsecutivos([consecutivoDoc()]),
      resoluciones: modeloResoluciones(resolucionDoc()),
    });

    const resultado = await service.findAll();

    expect(resultado.items).toHaveLength(1);
    expect(resultado.items[0].tipo).toBe('RC');
    expect(resultado.resolucion?.numeroResolucion).toBe('RES-001');
  });

  it('resolucion es null cuando no hay ninguna activa', async () => {
    const service = construir({ resoluciones: modeloResoluciones(null) });

    const resultado = await service.findAll();

    expect(resultado.resolucion).toBeNull();
  });
});

describe('DocumentosService.updateConsecutivo — guardrail de nextNumber', () => {
  it('responde "no existe" cuando el tipo de documento no tiene fila', async () => {
    const service = construir({ consecutivos: modeloConsecutivos([]) });

    await expect(
      service.updateConsecutivo('RC', { numeroSiguiente: 5 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('permite bajar nextNumber cuando el nuevo valor está por encima de lo ya emitido', async () => {
    // Emitidos: RC-1 .. RC-3. Bajar el contador a 5 es seguro (nada por
    // encima de 3 se pisaría).
    const recibos = modeloDocumentos([
      { fullNumber: 'RC-1' },
      { fullNumber: 'RC-2' },
      { fullNumber: 'RC-3' },
    ]);
    const service = construir({
      consecutivos: modeloConsecutivos([consecutivoDoc({ nextNumber: 10 })]),
      recibos,
    });

    const resultado = await service.updateConsecutivo('RC', {
      numeroSiguiente: 5,
    });

    expect(resultado.numero).toBe(5);
  });

  it('rechaza bajar nextNumber a un valor ya emitido bajo el mismo prefijo', async () => {
    // RC-7 ya existe — bajar el contador a 5 lo dejaría apuntando a un
    // número que un documento real ya lleva impreso.
    const recibos = modeloDocumentos([
      { fullNumber: 'RC-3' },
      { fullNumber: 'RC-7' },
    ]);
    const service = construir({
      consecutivos: modeloConsecutivos([consecutivoDoc({ nextNumber: 10 })]),
      recibos,
    });

    await expect(
      service.updateConsecutivo('RC', { numeroSiguiente: 5 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza bajar nextNumber exactamente al último número emitido', async () => {
    // El límite es estricto: nextNumber === maxIssued volvería a emitir el
    // mismo número, no solo uno menor.
    const recibos = modeloDocumentos([{ fullNumber: 'RC-7' }]);
    const service = construir({
      consecutivos: modeloConsecutivos([consecutivoDoc({ nextNumber: 10 })]),
      recibos,
    });

    await expect(
      service.updateConsecutivo('RC', { numeroSiguiente: 7 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cambiar de prefijo no dispara el guardrail — el prefijo nuevo no tiene nada emitido', async () => {
    const recibos = modeloDocumentos([{ fullNumber: 'RC-99' }]);
    const consecutivosFind = modeloConsecutivos([
      consecutivoDoc({ prefix: 'RC', nextNumber: 100 }),
    ]);
    const service = construir({ consecutivos: consecutivosFind, recibos });

    const resultado = await service.updateConsecutivo('RC', {
      prefijo: 'RC-2026',
      numeroSiguiente: 1,
    });

    expect(resultado.prefijo).toBe('RC-2026');
    expect(resultado.numero).toBe(1);
  });

  it('solo escribe los campos enviados (nombre/comprobante) sin tocar la numeración', async () => {
    const consecutivos = modeloConsecutivos([
      consecutivoDoc({ prefix: 'RC', nextNumber: 10 }),
    ]);
    const service = construir({ consecutivos });

    await service.updateConsecutivo('RC', {
      nombreDocumento: 'Recibo de Caja General',
      comprobanteContable: '09',
    });

    const [, update] = consecutivos.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).toEqual({
      displayName: 'Recibo de Caja General',
      accountingVoucherCode: '09',
    });
  });
});

describe('DocumentosService.crearResolucion', () => {
  it('rechaza un rango inválido antes de tocar la base de datos', async () => {
    const resoluciones = modeloResoluciones(null);
    const service = construir({ resoluciones });

    await expect(
      service.crearResolucion({
        numeroResolucion: 'RES-002',
        prefijo: 'CONJ-2027',
        rangoDesde: 100,
        rangoHasta: 50,
        vigenciaDesde: '2027-01-01',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resoluciones.create).not.toHaveBeenCalled();
  });

  it('crea la primera resolución de una copropiedad sin resolución previa', async () => {
    const resoluciones = modeloResoluciones(null);
    const service = construir({ resoluciones });

    const resultado = await service.crearResolucion({
      numeroResolucion: 'RES-001',
      prefijo: 'CONJ-2026',
      rangoDesde: 1,
      rangoHasta: 1000,
      vigenciaDesde: '2026-01-01',
    });

    expect(resultado.numeroResolucion).toBe('RES-001');
    expect(resoluciones.updateOne).not.toHaveBeenCalled();
  });

  it('desactiva la resolución anterior ANTES de crear la nueva — nunca al revés', async () => {
    // Regresión del bug real: crear antes de desactivar viola el índice
    // único parcial {coPropertyId, status:'active'} y lanza un error de
    // clave duplicada en cada copropiedad que YA tiene una activa (el caso
    // normal). El orden de las llamadas es lo único que prueba que el fix
    // sigue en pie.
    const anterior = resolucionDoc({ _id: new Types.ObjectId() });
    const resoluciones = modeloResoluciones(anterior);
    const service = construir({ resoluciones });

    const llamadas: string[] = [];
    resoluciones.updateOne.mockImplementation(() => {
      llamadas.push('updateOne');
      return {
        session: () => ({
          exec: () => Promise.resolve({ acknowledged: true }),
        }),
        exec: () => Promise.resolve({ acknowledged: true }),
      };
    });
    resoluciones.create.mockImplementation(
      (docs: Record<string, unknown>[]) => {
        llamadas.push('create');
        return Promise.resolve(
          docs.map((d) => ({ ...d, _id: new Types.ObjectId() })),
        );
      },
    );

    await service.crearResolucion({
      numeroResolucion: 'RES-002',
      prefijo: 'CONJ-2027',
      rangoDesde: 1,
      rangoHasta: 500,
      vigenciaDesde: '2027-01-01',
    });

    expect(llamadas).toEqual(['updateOne', 'create']);
    expect(resoluciones.updateOne).toHaveBeenCalledWith(
      { _id: anterior._id },
      { $set: { status: 'inactive' } },
    );
  });
});

describe('DocumentosService.actualizarResolucionMetadata', () => {
  it('responde "no existe" cuando no hay resolución activa', async () => {
    const service = construir({ resoluciones: modeloResoluciones(null) });

    await expect(
      service.actualizarResolucionMetadata({ nombreDocumento: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('solo escribe los campos de metadata enviados', async () => {
    const resoluciones = modeloResoluciones(resolucionDoc());
    const service = construir({ resoluciones });

    await service.actualizarResolucionMetadata({
      comprobanteContable: '03',
    });

    const [, update] = resoluciones.findByIdAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).toEqual({ accountingVoucherCode: '03' });
  });
});

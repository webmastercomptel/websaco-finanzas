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
  copropiedadId: COP,
  categoria: 'IN',
  codigo: 'RC',
  prefijo: 'RC',
  siguienteNumero: 10,
  nombreDocumento: 'Recibo de Caja',
  comprobanteContable: '02',
  numeroElectronico: null,
  ...over,
});

const resolucionDoc = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  numeroResolucion: 'RES-001',
  prefijo: 'CONJ-2026',
  rangoDesde: 1,
  rangoHasta: 1000,
  siguienteNumero: 5,
  vigenciaDesde: new Date('2026-01-01'),
  vigenciaHasta: null,
  estado: 'active',
  nombreDocumento: 'Cobro Expensas Comunes',
  comprobanteContable: '01',
  numeroElectronico: null,
  ...over,
});

/** A `find/findOne/findOneAndUpdate` chain mock that supports both a plain
 *  `.exec()` and `.session(s).exec()`/`.lean().exec()` — the shapes
 *  documentos.service.ts actually calls across its different methods. */
const modeloConsecutivos = (
  filas: Record<string, unknown>[],
  opts: { existeYa?: boolean } = {},
) => {
  const cadena = (data: unknown): Record<string, unknown> => ({
    session: () => cadena(data),
    sort: () => cadena(data),
    exec: () => Promise.resolve(data),
  });
  const creadas: Record<string, unknown>[] = [];
  return {
    creadas,
    find: jest.fn(() => cadena(filas)),
    findOne: jest.fn(() => cadena(filas[0] ?? null)),
    findOneAndUpdate: jest.fn(
      (_f: unknown, update: Record<string, unknown>) => {
        const set = (update as { $set: Record<string, unknown> }).$set;
        return cadena({ ...(filas[0] ?? {}), ...set });
      },
    ),
    exists: jest.fn(() => ({
      exec: () => Promise.resolve(opts.existeYa ? { _id: 'x' } : null),
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      creadas.push(doc);
      return Promise.resolve({ _id: new Types.ObjectId(), ...doc });
    }),
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
const modeloDocumentos = (docs: { numeroCompleto: string }[]) => ({
  find: jest.fn(() => ({
    lean: () => ({ exec: () => Promise.resolve(docs) }),
  })),
});

const construir = (opts: {
  consecutivos?: ReturnType<typeof modeloConsecutivos>;
  resoluciones?: ReturnType<typeof modeloResoluciones>;
  recibos?: ReturnType<typeof modeloDocumentos>;
  facturas?: ReturnType<typeof modeloDocumentos>;
  notasAnticipo?: ReturnType<typeof modeloDocumentos>;
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
    (opts.notasAnticipo ?? modeloDocumentos([])) as never,
    (opts.facturas ?? modeloDocumentos([])) as never,
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
    expect(resultado.items[0].categoria).toBe('IN');
    expect(resultado.items[0].codigo).toBe('RC');
    expect(resultado.resolucion?.numeroResolucion).toBe('RES-001');
  });

  it('resolucion es null cuando no hay ninguna activa', async () => {
    const service = construir({ resoluciones: modeloResoluciones(null) });

    const resultado = await service.findAll();

    expect(resultado.resolucion).toBeNull();
  });
});

describe('DocumentosService.crearConsecutivo', () => {
  it('permite crear un consecutivo para FV — la resolución DIAN es opcional', async () => {
    const consecutivos = modeloConsecutivos([], { existeYa: false });
    const service = construir({ consecutivos });

    const resultado = await service.crearConsecutivo('FV', { codigo: 'FV' });

    expect(consecutivos.creadas[0]).toMatchObject({
      categoria: 'FV',
      codigo: 'FV',
    });
    expect(resultado.categoria).toBe('FV');
  });

  it('rechaza si ya existe un consecutivo con ese código', async () => {
    const consecutivos = modeloConsecutivos([], { existeYa: true });
    const service = construir({ consecutivos });

    await expect(
      service.crearConsecutivo('IN', { codigo: 'RC' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(consecutivos.create).not.toHaveBeenCalled();
  });

  it('crea con los defaults correctos cuando no vienen', async () => {
    const consecutivos = modeloConsecutivos([], { existeYa: false });
    const service = construir({ consecutivos });

    const resultado = await service.crearConsecutivo('NC', { codigo: 'NC' });

    expect(consecutivos.creadas[0]).toMatchObject({
      categoria: 'NC',
      codigo: 'NC',
      prefijo: 'NC',
      siguienteNumero: 0,
      nombreDocumento: null,
      comprobanteContable: null,
    });
    expect(resultado.categoria).toBe('NC');
    expect(resultado.codigo).toBe('NC');
  });

  it('permite varios códigos bajo la misma categoría', async () => {
    const consecutivos = modeloConsecutivos([], { existeYa: false });
    const service = construir({ consecutivos });

    await service.crearConsecutivo('IN', {
      codigo: 'CI',
      nombreDocumento: 'Comprobante de Ingreso',
    });

    expect(consecutivos.creadas[0]).toMatchObject({
      categoria: 'IN',
      codigo: 'CI',
    });
  });

  it('usa el prefijo y número inicial enviados', async () => {
    const consecutivos = modeloConsecutivos([], { existeYa: false });
    const service = construir({ consecutivos });

    await service.crearConsecutivo('ND', {
      codigo: 'ND',
      prefijo: 'ND-2026',
      numeroInicial: 500,
      nombreDocumento: 'Nota Débito',
      comprobanteContable: '05',
    });

    expect(consecutivos.creadas[0]).toMatchObject({
      categoria: 'ND',
      codigo: 'ND',
      prefijo: 'ND-2026',
      siguienteNumero: 500,
      nombreDocumento: 'Nota Débito',
      comprobanteContable: '05',
    });
  });
});

describe('DocumentosService.updateConsecutivo — guardrail de siguienteNumero', () => {
  it('responde "no existe" cuando el tipo de documento no tiene fila', async () => {
    const service = construir({ consecutivos: modeloConsecutivos([]) });

    await expect(
      service.updateConsecutivo('RC', { numeroSiguiente: 5 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('permite bajar siguienteNumero cuando el nuevo valor está por encima de lo ya emitido', async () => {
    // Emitidos: RC-1 .. RC-3. Bajar el contador a 5 es seguro (nada por
    // encima de 3 se pisaría).
    const recibos = modeloDocumentos([
      { numeroCompleto: 'RC-1' },
      { numeroCompleto: 'RC-2' },
      { numeroCompleto: 'RC-3' },
    ]);
    const service = construir({
      consecutivos: modeloConsecutivos([
        consecutivoDoc({ siguienteNumero: 10 }),
      ]),
      recibos,
    });

    const resultado = await service.updateConsecutivo('RC', {
      numeroSiguiente: 5,
    });

    expect(resultado.numero).toBe(5);
  });

  it('rechaza bajar siguienteNumero a un valor ya emitido bajo el mismo prefijo', async () => {
    // RC-7 ya existe — bajar el contador a 5 lo dejaría apuntando a un
    // número que un documento real ya lleva impreso.
    const recibos = modeloDocumentos([
      { numeroCompleto: 'RC-3' },
      { numeroCompleto: 'RC-7' },
    ]);
    const service = construir({
      consecutivos: modeloConsecutivos([
        consecutivoDoc({ siguienteNumero: 10 }),
      ]),
      recibos,
    });

    await expect(
      service.updateConsecutivo('RC', { numeroSiguiente: 5 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza bajar siguienteNumero exactamente al último número emitido', async () => {
    // El límite es estricto: siguienteNumero === maxIssued volvería a emitir
    // el mismo número, no solo uno menor.
    const recibos = modeloDocumentos([{ numeroCompleto: 'RC-7' }]);
    const service = construir({
      consecutivos: modeloConsecutivos([
        consecutivoDoc({ siguienteNumero: 10 }),
      ]),
      recibos,
    });

    await expect(
      service.updateConsecutivo('RC', { numeroSiguiente: 7 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cambiar de prefijo no dispara el guardrail — el prefijo nuevo no tiene nada emitido', async () => {
    const recibos = modeloDocumentos([{ numeroCompleto: 'RC-99' }]);
    const consecutivosFind = modeloConsecutivos([
      consecutivoDoc({ prefijo: 'RC', siguienteNumero: 100 }),
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
      consecutivoDoc({ prefijo: 'RC', siguienteNumero: 10 }),
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
      nombreDocumento: 'Recibo de Caja General',
      comprobanteContable: '09',
    });
  });

  it('el código NA revisa la colección de Notas de Anticipo, no la de Notas Contables — aunque comparta categoría NT', async () => {
    // NA-5 ya existe como Nota de Anticipo real — bajar el contador a 3
    // debe rechazarse. Si el guardrail mirara `notas_contables` (la
    // colección genérica de la categoría NT) en vez de `notas_anticipo`,
    // nunca vería este documento y dejaría pasar el pisado.
    const notasAnticipo = modeloDocumentos([{ numeroCompleto: 'NA-5' }]);
    const notasContablesVacia = modeloDocumentos([]);
    const consecutivos = modeloConsecutivos([
      consecutivoDoc({
        categoria: 'NT',
        codigo: 'NA',
        prefijo: 'NA',
        siguienteNumero: 10,
      }),
    ]);
    const service = new DocumentosService(
      consecutivos as never,
      modeloResoluciones(null) as never,
      modeloDocumentos([]) as never, // recibos
      modeloDocumentos([]) as never, // notasCredito
      modeloDocumentos([]) as never, // notasDebito
      notasContablesVacia as never,
      notasAnticipo as never,
      modeloDocumentos([]) as never, // facturas
      tenantQueDevuelve(),
      conexionCon(sesionFalsa()),
    );

    await expect(
      service.updateConsecutivo('NA', { numeroSiguiente: 3 }),
    ).rejects.toBeInstanceOf(ConflictException);
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
    // único parcial {copropiedadId, estado:'active'} y lanza un error de
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
      { $set: { estado: 'inactive' } },
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
    expect(update.$set).toEqual({ comprobanteContable: '03' });
  });
});

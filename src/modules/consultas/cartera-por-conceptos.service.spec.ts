import { Types } from 'mongoose';
import { CarteraPorConceptosService } from './cartera-por-conceptos.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'FV-001',
  number: 1,
  issueDate: new Date('2026-08-01'),
  dueDate: new Date('2026-08-31'),
  total: 200000,
  lines: [],
  status: 'emitida',
  ...over,
});

const ndDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'ND-001',
  number: 1,
  issueDate: new Date('2026-07-15'),
  total: 50000,
  conceptoId: id(),
  status: 'emitida',
  ...over,
});

const inmuebleDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  code: '301',
  holderId: null,
  status: 'active',
  ...over,
});

const conceptoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  name: 'Administracion',
  sortOrder: 100,
  ...over,
});

const find = (data: unknown[] = []) => ({
  find: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(data),
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const defaults: Record<string, unknown> = {
    facturas: find(),
    notasDebito: find(),
    aplicaciones: find(),
    conceptosCobro: find(),
    carteraPorDocumento: find(),
    saldoTotalDocumento: find(),
    inmuebles: find(),
    terceros: find(),
    tenant: { resolveCoPropertyId: () => COP },
    saldosIniciales: find(),
  };
  const m = { ...defaults, ...overrides };
  return new CarteraPorConceptosService(
    m.facturas as never,
    m.notasDebito as never,
    m.aplicaciones as never,
    m.conceptosCobro as never,
    m.carteraPorDocumento as never,
    m.saldoTotalDocumento as never,
    m.inmuebles as never,
    m.terceros as never,
    m.tenant as never,
    m.saldosIniciales as never,
  );
};

describe('CarteraPorConceptosService', () => {
  it('sin documentos pendientes, devuelve los conceptos del catalogo y ningun grupo', async () => {
    const concepto = conceptoDoc({ name: 'Administracion' });
    const svc = servicio({ conceptosCobro: find([concepto]) });

    const result = await svc.findAll({});

    expect(result.grupos).toEqual([]);
    expect(result.conceptos).toEqual([
      { conceptoId: concepto._id.toString(), nombre: 'Administracion' },
    ]);
  });

  it('agrupa los documentos pendientes por inmueble, con titular y celular resueltos desde holderId', async () => {
    const inmId = id();
    const holderId = id();
    const fId = id();
    const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 200000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301', holderId });
    const tercero = { _id: holderId, name: 'Juan Perez', phone: '3001234567' };

    const svc = servicio({
      facturas: find([f]),
      inmuebles: find([inm]),
      terceros: find([tercero]),
      saldoTotalDocumento: find([{ documentoId: fId, saldoPendiente: 200000 }]),
    });

    const result = await svc.findAll({});

    expect(result.grupos).toHaveLength(1);
    expect(result.grupos[0]).toMatchObject({
      inmuebleId: inmId.toString(),
      inmuebleCodigo: '301',
      titular: 'Juan Perez',
      celular: '3001234567',
      saldoTotal: 200000,
    });
    expect(result.grupos[0].documentos).toEqual([
      {
        documentoId: fId.toString(),
        tipo: 'FV',
        numeroCompleto: 'FV-001',
        fecha: f.issueDate.toISOString(),
        vence: f.dueDate.toISOString(),
        saldo: 200000,
        cargosPorConcepto: {},
      },
    ]);
  });

  it('filtra por estadoInmueble — solo activos', async () => {
    const inmActivoId = id();
    const inmInactivoId = id();
    const inmActivo = inmuebleDoc({
      _id: inmActivoId,
      code: '301',
      status: 'active',
    });
    const inmInactivo = inmuebleDoc({
      _id: inmInactivoId,
      code: '402',
      status: 'inactive',
    });
    const fActivo = facturaDoc({ inmuebleId: inmActivoId, total: 100000 });
    const fInactivo = facturaDoc({ inmuebleId: inmInactivoId, total: 50000 });

    const svc = servicio({
      facturas: find([fActivo, fInactivo]),
      inmuebles: find([inmActivo, inmInactivo]),
      saldoTotalDocumento: find([
        { documentoId: fActivo._id, saldoPendiente: 100000 },
        { documentoId: fInactivo._id, saldoPendiente: 50000 },
      ]),
    });

    const result = await svc.findAll({ estadoInmueble: 'activo' });

    expect(result.grupos).toHaveLength(1);
    expect(result.grupos[0].inmuebleCodigo).toBe('301');
  });

  it('filtra por estadoInmueble — solo inactivos', async () => {
    const inmActivoId = id();
    const inmInactivoId = id();
    const inmActivo = inmuebleDoc({
      _id: inmActivoId,
      code: '301',
      status: 'active',
    });
    const inmInactivo = inmuebleDoc({
      _id: inmInactivoId,
      code: '402',
      status: 'inactive',
    });
    const fActivo = facturaDoc({ inmuebleId: inmActivoId, total: 100000 });
    const fInactivo = facturaDoc({ inmuebleId: inmInactivoId, total: 50000 });

    const svc = servicio({
      facturas: find([fActivo, fInactivo]),
      inmuebles: find([inmActivo, inmInactivo]),
      saldoTotalDocumento: find([
        { documentoId: fActivo._id, saldoPendiente: 100000 },
        { documentoId: fInactivo._id, saldoPendiente: 50000 },
      ]),
    });

    const result = await svc.findAll({ estadoInmueble: 'inactivo' });

    expect(result.grupos).toHaveLength(1);
    expect(result.grupos[0].inmuebleCodigo).toBe('402');
  });

  it('sin estadoInmueble, incluye activos e inactivos por igual', async () => {
    const inmActivoId = id();
    const inmInactivoId = id();
    const inmActivo = inmuebleDoc({
      _id: inmActivoId,
      code: '301',
      status: 'active',
    });
    const inmInactivo = inmuebleDoc({
      _id: inmInactivoId,
      code: '402',
      status: 'inactive',
    });
    const fActivo = facturaDoc({ inmuebleId: inmActivoId, total: 100000 });
    const fInactivo = facturaDoc({ inmuebleId: inmInactivoId, total: 50000 });

    const svc = servicio({
      facturas: find([fActivo, fInactivo]),
      inmuebles: find([inmActivo, inmInactivo]),
      saldoTotalDocumento: find([
        { documentoId: fActivo._id, saldoPendiente: 100000 },
        { documentoId: fInactivo._id, saldoPendiente: 50000 },
      ]),
    });

    const result = await svc.findAll({});

    expect(result.grupos).toHaveLength(2);
  });

  it('ordena los documentos de un mismo inmueble por fecha ascendente, mezclando FV y ND', async () => {
    const inmId = id();
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    const fId = id();
    const ndId = id();
    const f = facturaDoc({
      _id: fId,
      inmuebleId: inmId,
      number: 7,
      fullNumber: 'FV-0007',
      issueDate: new Date('2026-08-01'),
      total: 100000,
    });
    const nd = ndDoc({
      _id: ndId,
      inmuebleId: inmId,
      number: 3,
      fullNumber: 'ND-0003',
      issueDate: new Date('2026-07-15'),
      total: 20000,
    });

    const svc = servicio({
      facturas: find([f]),
      notasDebito: find([nd]),
      inmuebles: find([inm]),
      saldoTotalDocumento: find([
        { documentoId: fId, saldoPendiente: 100000 },
        { documentoId: ndId, saldoPendiente: 20000 },
      ]),
    });

    const result = await svc.findAll({});

    expect(result.grupos[0].documentos.map((d) => d.numeroCompleto)).toEqual([
      'ND-0003',
      'FV-0007',
    ]);
  });

  it('la fecha manda sobre el número — un número más alto pero fecha más temprana va primero (bug real reportado)', async () => {
    const inmId = id();
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    const fId = id();
    const ndId = id();
    // Número más alto (337) pero fecha más temprana — antes de la
    // corrección el orden crudo por número lo dejaba de último.
    const f = facturaDoc({
      _id: fId,
      inmuebleId: inmId,
      number: 337,
      fullNumber: 'FV-337',
      issueDate: new Date('2026-06-01'),
      total: 100000,
    });
    const nd = ndDoc({
      _id: ndId,
      inmuebleId: inmId,
      number: 5,
      fullNumber: 'ND-5',
      issueDate: new Date('2026-08-21'),
      total: 20000,
    });

    const svc = servicio({
      facturas: find([f]),
      notasDebito: find([nd]),
      inmuebles: find([inm]),
      saldoTotalDocumento: find([
        { documentoId: fId, saldoPendiente: 100000 },
        { documentoId: ndId, saldoPendiente: 20000 },
      ]),
    });

    const result = await svc.findAll({});

    expect(result.grupos[0].documentos.map((d) => d.numeroCompleto)).toEqual([
      'FV-337',
      'ND-5',
    ]);
  });

  it('trae el desglose por concepto desde CarteraPorDocumento, el ledger vivo', async () => {
    const inmId = id();
    const fId = id();
    const conceptoAdmin = id();
    const conceptoMultas = id();
    const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 150000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: find([f]),
      inmuebles: find([inm]),
      saldoTotalDocumento: find([{ documentoId: fId, saldoPendiente: 150000 }]),
      carteraPorDocumento: find([
        { documentoId: fId, conceptoId: conceptoAdmin, saldoPendiente: 100000 },
        { documentoId: fId, conceptoId: conceptoMultas, saldoPendiente: 50000 },
        // A zeroed-out row (fully reclassified away) must not appear.
        { documentoId: fId, conceptoId: id(), saldoPendiente: 0 },
      ]),
    });

    const result = await svc.findAll({});

    expect(result.grupos[0].documentos[0].cargosPorConcepto).toEqual({
      [conceptoAdmin.toString()]: 100000,
      [conceptoMultas.toString()]: 50000,
    });
  });

  it('una Factura totalmente pagada (SaldoTotalDocumento en 0) no aparece', async () => {
    const inmId = id();
    const fId = id();
    const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: find([f]),
      inmuebles: find([inm]),
      saldoTotalDocumento: find([{ documentoId: fId, saldoPendiente: 0 }]),
    });

    const result = await svc.findAll({});

    expect(result.grupos).toEqual([]);
  });

  it('ordena los grupos por codigo de inmueble', async () => {
    const inm2Id = id();
    const inm10Id = id();
    const f2 = facturaDoc({ inmuebleId: inm2Id, total: 10000 });
    const f10 = facturaDoc({ inmuebleId: inm10Id, total: 10000 });
    const inm2 = inmuebleDoc({ _id: inm2Id, code: '002' });
    const inm10 = inmuebleDoc({ _id: inm10Id, code: '010' });

    const svc = servicio({
      facturas: find([f10, f2]),
      inmuebles: find([inm2, inm10]),
      saldoTotalDocumento: find([
        { documentoId: f2._id, saldoPendiente: 10000 },
        { documentoId: f10._id, saldoPendiente: 10000 },
      ]),
    });

    const result = await svc.findAll({});

    expect(result.grupos.map((g) => g.inmuebleCodigo)).toEqual(['002', '010']);
  });

  it('con fecha de corte historica: ignora documentos emitidos despues del corte', async () => {
    const inmId = id();
    const fAntes = facturaDoc({
      inmuebleId: inmId,
      issueDate: new Date('2026-07-01'),
      total: 100000,
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const facturasFind = jest.fn().mockReturnThis();
    const svc = servicio({
      facturas: {
        find: facturasFind,
        exec: jest.fn().mockResolvedValue([fAntes]),
      },
      inmuebles: find([inm]),
    });

    await svc.findAll({ fecha: '2026-08-01' });

    // `issueDate` is a PURE calendar date (always UTC midnight, never a real
    // time-of-day) — the bound must be the un-shifted end of "2026-08-01" in
    // UTC, NOT `finDelDiaCorte`'s own 2026-08-02T04:59:59.999Z (that reach
    // is only correct for a REAL timestamp like `appliedAt`; applied here it
    // would wrongly include a Factura issued at UTC midnight the next day —
    // see `limiteEmisionParaCorte`'s own docblock).
    expect(facturasFind).toHaveBeenCalledWith(
      expect.objectContaining({
        issueDate: { $lte: new Date('2026-08-01T23:59:59.999Z') },
      }),
    );
  });

  it('con fecha de corte historica: reparte el saldo proporcionalmente entre las lineas congeladas de la Factura, no el ledger vivo', async () => {
    const inmId = id();
    const conceptoAdmin = id();
    const conceptoMultas = id();
    const f = facturaDoc({
      inmuebleId: inmId,
      total: 150000,
      issueDate: new Date('2026-06-01'),
      lines: [
        { conceptoId: conceptoAdmin, totalAmount: 100000 },
        { conceptoId: conceptoMultas, totalAmount: 50000 },
      ],
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: find([f]),
      inmuebles: find([inm]),
      // Never consulted for a historical query — a value here would only
      // prove the wrong branch ran.
      carteraPorDocumento: find([
        { documentoId: f._id, conceptoId: conceptoAdmin, saldoPendiente: 999 },
      ]),
    });

    const result = await svc.findAll({ fecha: '2026-06-15' });

    expect(result.grupos[0].documentos[0].cargosPorConcepto).toEqual({
      [conceptoAdmin.toString()]: 100000,
      [conceptoMultas.toString()]: 50000,
    });
  });

  it('con fecha de corte historica: un pago aplicado despues del corte no reduce el saldo', async () => {
    const inmId = id();
    const fId = id();
    const f = facturaDoc({
      _id: fId,
      inmuebleId: inmId,
      total: 100000,
      issueDate: new Date('2026-06-01'),
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    const app = {
      _id: id(),
      documentId: fId,
      amountApplied: 100000,
      status: 'activa',
      appliedAt: new Date('2026-07-01'),
      revertedAt: null,
    };

    const svc = servicio({
      facturas: find([f]),
      aplicaciones: find([app]),
      inmuebles: find([inm]),
    });

    const result = await svc.findAll({ fecha: '2026-06-15' });

    expect(result.grupos[0].documentos[0].saldo).toBe(100000);
  });
});

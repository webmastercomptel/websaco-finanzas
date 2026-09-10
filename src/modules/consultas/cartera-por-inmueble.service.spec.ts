import { Types } from 'mongoose';
import { CarteraPorInmuebleService } from './cartera-por-inmueble.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'FV-001',
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

const findOneStub = (doc: unknown) => ({
  exec: jest.fn().mockResolvedValue(doc),
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const find = (data: unknown[] = []) => ({
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn().mockReturnValue(findOneStub(data[0] ?? null)),
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(data),
  });
  const defaults: Record<string, unknown> = {
    facturas: find(),
    notasDebito: find(),
    aplicaciones: find(),
    conceptosCobro: find(),
    inmuebles: find(),
    terceros: find(),
    tenant: { resolveCoPropertyId: () => COP },
  };
  const m = { ...defaults, ...overrides };
  return new CarteraPorInmuebleService(
    m.facturas as never,
    m.notasDebito as never,
    m.aplicaciones as never,
    m.conceptosCobro as never,
    m.inmuebles as never,
    m.terceros as never,
    m.tenant as never,
  );
};

describe('CarteraPorInmuebleService', () => {
  it('una Factura pendiente aparece como documento FV con su saldo total', async () => {
    const inmId = id();
    const f = facturaDoc({ inmuebleId: inmId, total: 200000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([f]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findOne({ inmuebleId: inmId.toString() });

    expect(result.documentos).toHaveLength(1);
    expect(result.documentos[0]).toMatchObject({
      tipo: 'FV',
      numeroCompleto: 'FV-001',
      saldo: 200000,
    });
    expect(result.saldoTotalCartera).toBe(200000);
  });

  it('una aplicacion activa reduce el saldo de la Factura y de su concepto', async () => {
    const inmId = id();
    const fId = id();
    const conceptoId = id();
    const f = facturaDoc({
      _id: fId,
      inmuebleId: inmId,
      total: 200000,
      lines: [
        {
          conceptoId,
          conceptName: 'Administracion',
          totalAmount: 200000,
        },
      ],
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    const concepto = conceptoDoc({ _id: conceptoId, name: 'Administracion' });
    const app = {
      _id: id(),
      documentId: fId,
      amountApplied: 80000,
      status: 'activa',
      appliedAt: new Date('2026-08-10'),
      revertedAt: null,
    };

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      aplicaciones: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([app]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
      conceptosCobro: {
        find: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([concepto]),
      },
    });

    const result = await svc.findOne({ inmuebleId: inmId.toString() });

    expect(result.documentos[0].saldo).toBe(120000);
    expect(result.documentos[0].cargosPorConcepto).toEqual({
      [conceptoId.toString()]: 120000,
    });
    expect(result.cargosPorConcepto).toEqual([
      {
        conceptoId: conceptoId.toString(),
        nombre: 'Administracion',
        monto: 120000,
      },
    ]);
    expect(result.saldoTotalCartera).toBe(120000);
  });

  it('una Factura con lineas de varios conceptos reparte su saldo por concepto en el mismo documento', async () => {
    const inmId = id();
    const conceptoAdmin = id();
    const conceptoMultas = id();
    const f = facturaDoc({
      inmuebleId: inmId,
      total: 150000,
      lines: [
        {
          conceptoId: conceptoAdmin,
          conceptName: 'Administracion',
          totalAmount: 100000,
        },
        {
          conceptoId: conceptoMultas,
          conceptName: 'Multas',
          totalAmount: 50000,
        },
      ],
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findOne({ inmuebleId: inmId.toString() });

    expect(result.documentos).toHaveLength(1);
    expect(result.documentos[0].cargosPorConcepto).toEqual({
      [conceptoAdmin.toString()]: 100000,
      [conceptoMultas.toString()]: 50000,
    });
  });

  it('una Factura totalmente pagada no aparece en documentos', async () => {
    const inmId = id();
    const fId = id();
    const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    const app = {
      _id: id(),
      documentId: fId,
      amountApplied: 100000,
      status: 'activa',
      appliedAt: new Date('2026-08-10'),
      revertedAt: null,
    };

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      aplicaciones: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([app]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findOne({ inmuebleId: inmId.toString() });

    expect(result.documentos).toHaveLength(0);
    expect(result.saldoTotalCartera).toBe(0);
  });

  it('una NotaDebito pendiente contribuye su total al concepto que la genero', async () => {
    const inmId = id();
    const conceptoId = id();
    const nd = ndDoc({ inmuebleId: inmId, conceptoId, total: 50000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    const concepto = conceptoDoc({ _id: conceptoId, name: 'Multas' });

    const svc = servicio({
      notasDebito: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([nd]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
      conceptosCobro: {
        find: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([concepto]),
      },
    });

    const result = await svc.findOne({ inmuebleId: inmId.toString() });

    expect(result.documentos[0]).toMatchObject({ tipo: 'ND', saldo: 50000 });
    expect(result.cargosPorConcepto).toEqual([
      { conceptoId: conceptoId.toString(), nombre: 'Multas', monto: 50000 },
    ]);
  });

  it('incluye cada concepto del catalogo con monto 0 cuando no tiene cargos pendientes', async () => {
    const inmId = id();
    const conceptoConSaldo = id();
    const conceptoSinSaldo = id();
    const f = facturaDoc({
      inmuebleId: inmId,
      total: 100000,
      lines: [
        {
          conceptoId: conceptoConSaldo,
          conceptName: 'Administracion',
          totalAmount: 100000,
        },
      ],
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
      conceptosCobro: {
        find: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          conceptoDoc({
            _id: conceptoConSaldo,
            name: 'Administracion',
            sortOrder: 100,
          }),
          conceptoDoc({
            _id: conceptoSinSaldo,
            name: 'Multas',
            sortOrder: 200,
          }),
        ]),
      },
    });

    const result = await svc.findOne({ inmuebleId: inmId.toString() });

    expect(result.cargosPorConcepto).toEqual([
      {
        conceptoId: conceptoConSaldo.toString(),
        nombre: 'Administracion',
        monto: 100000,
      },
      { conceptoId: conceptoSinSaldo.toString(), nombre: 'Multas', monto: 0 },
    ]);
  });

  it('resuelve inmuebleCodigo y propietario desde Inmueble.holderId -> Tercero.name', async () => {
    const inmId = id();
    const holderId = id();
    const inm = inmuebleDoc({ _id: inmId, code: '401', holderId });
    const tercero = { _id: holderId, name: 'Juan Perez' };

    const svc = servicio({
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
      terceros: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(tercero)),
        exec: jest.fn().mockResolvedValue([tercero]),
      },
    });

    const result = await svc.findOne({ inmuebleId: inmId.toString() });

    expect(result.inmuebleCodigo).toBe('401');
    expect(result.propietario).toBe('Juan Perez');
  });

  it('con fecha de corte historica: ignora documentos emitidos despues del corte', async () => {
    const inmId = id();
    const fAntes = facturaDoc({
      inmuebleId: inmId,
      fullNumber: 'FV-001',
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
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    await svc.findOne({ inmuebleId: inmId.toString(), fecha: '2026-08-01' });

    // End of "2026-08-01" in Colombia local time (UTC-5) is
    // 2026-08-02T04:59:59.999Z — see `finDelDiaCorte`.
    expect(facturasFind).toHaveBeenCalledWith(
      expect.objectContaining({
        issueDate: { $lte: new Date('2026-08-02T04:59:59.999Z') },
      }),
    );
  });

  it('con fecha de corte = hoy: cuenta un pago aplicado hoy con hora real, no solo a medianoche', async () => {
    // Reproduces the reported bug: typing today's date as Fecha Corte must
    // behave like "up to right now, today", not "up to midnight today" —
    // otherwise a same-day Recibo (whose `appliedAt` carries a real
    // timestamp, not midnight) reads as not-yet-applied and the invoice
    // looks pending when it was actually paid off today.
    const inmId = id();
    const fId = id();
    const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    const hoy = new Date();
    const hoyIso = hoy.toISOString().slice(0, 10);
    const appEstaTarde = {
      _id: id(),
      documentId: fId,
      amountApplied: 100000,
      status: 'activa',
      appliedAt: new Date(hoy.getTime() + 60_000),
      revertedAt: null,
    };

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      aplicaciones: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([appEstaTarde]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findOne({
      inmuebleId: inmId.toString(),
      fecha: hoyIso,
    });

    expect(result.documentos).toHaveLength(0);
  });

  it('con fecha de corte = hoy: cuenta un Recibo aplicado esta noche en Colombia aunque su timestamp UTC ya sea "manana" (bug real reportado)', async () => {
    // Colombia is UTC-5: a Recibo applied at 8pm local time on "today" is
    // stored with a UTC `appliedAt` that already reads 1am the NEXT
    // calendar day. Picking "today" (Colombia) as Fecha Corte must still
    // count it — this is the exact scenario the user hit with RC-4.
    const inmId = id();
    const fId = id();
    const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    // "today" in Colombia, expressed as the UTC instant for 8pm local
    // (UTC-5) — i.e. 01:00 UTC the following calendar day.
    const hoyColombia = new Date('2026-08-15T00:00:00.000Z');
    const hoyIso = '2026-08-15';
    const appEstaNoche = {
      _id: id(),
      documentId: fId,
      amountApplied: 100000,
      status: 'activa',
      appliedAt: new Date(hoyColombia.getTime() + 25 * 60 * 60 * 1000), // next-day 01:00 UTC
      revertedAt: null,
    };

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      aplicaciones: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([appEstaNoche]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnValue(findOneStub(inm)),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findOne({
      inmuebleId: inmId.toString(),
      fecha: hoyIso,
    });

    expect(result.documentos).toHaveLength(0);
    expect(result.saldoTotalCartera).toBe(0);
  });
});

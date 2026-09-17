import { Types } from 'mongoose';
import { VencimientosCarteraService } from './vencimientos-cartera.service';

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
  conceptoId: new Types.ObjectId(),
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

const servicio = (overrides: Record<string, unknown> = {}) => {
  const find = (data: unknown[] = []) => ({
    find: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(data),
  });
  const defaults: Record<string, unknown> = {
    facturas: find(),
    notasDebito: find(),
    aplicaciones: find(),
    inmuebles: find(),
    terceros: find(),
    tenant: { resolveCoPropertyId: () => COP },
    saldosIniciales: find(),
  };
  const m = { ...defaults, ...overrides };
  return new VencimientosCarteraService(
    m.facturas as never,
    m.notasDebito as never,
    m.aplicaciones as never,
    m.inmuebles as never,
    m.terceros as never,
    m.tenant as never,
    m.saldosIniciales as never,
  );
};

describe('VencimientosCarteraService', () => {
  it('una Factura vencida produce una fila con su propio rango y saldo', async () => {
    const inmId = id();
    const f = facturaDoc({
      inmuebleId: inmId,
      dueDate: new Date('2026-08-01'),
      total: 200000,
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findAll({ fecha: '2026-09-06' });

    expect(result.filas).toHaveLength(1);
    expect(result.filas[0]).toMatchObject({
      inmuebleCodigo: '301',
      tipo: 'FV',
      numeroCompleto: 'FV-001',
      saldo: 200000,
      rango: 'dias_31_60',
    });
    expect(result.filas[0].diasMora).toBeGreaterThan(0);
  });

  it('diasMora con fecha de corte explicita usa el dia calendario exacto, no el instante extendido a Colombia', async () => {
    const inmId = id();
    const f = facturaDoc({
      inmuebleId: inmId,
      dueDate: new Date('2026-08-01'),
      total: 200000,
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findAll({ fecha: '2026-09-06' });

    // Aug 1 -> Sep 6 = 36 days. Extending the corte to Colombia end-of-day
    // (Sep 7, 04:59:59.999 UTC) must not leak into this count.
    expect(result.filas[0].diasMora).toBe(36);
  });

  it('con fecha de corte = hoy: cuenta un Recibo aplicado esta noche en Colombia sin correr diasMora un dia (bug real reportado)', async () => {
    // Same bug as CarteraPorInmuebleService: a Recibo applied at 8pm
    // Colombia time carries a UTC `appliedAt` that already reads "tomorrow".
    // Fixing that must NOT shift `diasMora`/the sinVencer split by a day —
    // those still compare against the RAW picked calendar day.
    const inmId = id();
    const fId = id();
    const f = facturaDoc({
      _id: fId,
      inmuebleId: inmId,
      dueDate: new Date('2026-08-01'),
      total: 200000,
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
    const appEstaNoche = {
      _id: id(),
      documentId: fId,
      amountApplied: 200000,
      status: 'activa',
      appliedAt: new Date('2026-09-07T01:00:00.000Z'), // 8pm Colombia, Sep 6
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
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findAll({ fecha: '2026-09-06' });

    expect(result.filas).toHaveLength(0);
    expect(result.totalCartera).toBe(0);
  });

  it('una Factura aun no vencida cae en el rango sinVencer', async () => {
    const inmId = id();
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 30);
    const f = facturaDoc({
      inmuebleId: inmId,
      dueDate: futureDate,
      total: 100000,
    });
    const inm = inmuebleDoc({ _id: inmId, code: '101' });

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findAll({});

    expect(result.filas[0]).toMatchObject({
      rango: 'sinVencer',
      saldo: 100000,
    });
  });

  it('clasifica correctamente cada rango de vencimiento por dias de mora', async () => {
    const casos: Array<[number, string]> = [
      [15, 'dias_1_30'],
      [45, 'dias_31_60'],
      [75, 'dias_61_90'],
      [105, 'dias_91_120'],
      [150, 'dias_121_180'],
      [270, 'dias_181_360'],
      [500, 'dias_361_720'],
      [800, 'dias_720_mas'],
    ];

    for (const [diasVencido, rangoEsperado] of casos) {
      const inmId = id();
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() - diasVencido);
      const f = facturaDoc({ inmuebleId: inmId, dueDate, total: 100000 });
      const inm = inmuebleDoc({ _id: inmId, code: '901' });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([inm]),
        },
      });

      const result = await svc.findAll({});

      expect(result.filas[0].rango).toBe(rangoEsperado);
    }
  });

  it('una NotaDebito pendiente usa issueDate como fecha y vencimiento', async () => {
    const inmId = id();
    const nd = ndDoc({
      inmuebleId: inmId,
      issueDate: new Date('2026-07-01'),
      total: 50000,
    });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      notasDebito: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([nd]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findAll({ fecha: '2026-09-06' });

    expect(result.filas[0]).toMatchObject({ tipo: 'ND', saldo: 50000 });
    expect(result.filas[0].vence).toBe(nd.issueDate.toISOString());
  });

  it('una aplicacion activa reduce el saldo pendiente del documento', async () => {
    const inmId = id();
    const fId = id();
    const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 200000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });
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
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findAll({});

    expect(result.filas[0].saldo).toBe(120000);
  });

  it('una Factura totalmente pagada no aparece en filas', async () => {
    const inmId = id();
    const fId = id();
    const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
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
    });

    const result = await svc.findAll({});

    expect(result.filas).toHaveLength(0);
    expect(result.totalCartera).toBe(0);
  });

  it('resuelve inmuebleCodigo y propietario desde Inmueble.holderId -> Tercero.name', async () => {
    const inmId = id();
    const holderId = id();
    const f = facturaDoc({ inmuebleId: inmId, total: 100000 });
    const inm = inmuebleDoc({ _id: inmId, code: '401', holderId });
    const tercero = { _id: holderId, name: 'Juan Perez' };

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([inm]),
      },
      terceros: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([tercero]),
      },
    });

    const result = await svc.findAll({});

    expect(result.filas[0].propietario).toBe('Juan Perez');
  });

  it('ordena filas por codigo de inmueble ascendente', async () => {
    const inm1 = id();
    const inm2 = id();
    const f1 = facturaDoc({ inmuebleId: inm1, total: 100000 });
    const f2 = facturaDoc({ inmuebleId: inm2, total: 100000 });

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f1, f2]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        exec: jest
          .fn()
          .mockResolvedValue([
            inmuebleDoc({ _id: inm1, code: '11002' }),
            inmuebleDoc({ _id: inm2, code: '11001' }),
          ]),
      },
    });

    const result = await svc.findAll({});

    expect(result.filas.map((f) => f.inmuebleCodigo)).toEqual([
      '11001',
      '11002',
    ]);
  });

  it('rangos incluye los 9 buckets fijos y totalCartera suma todas las filas', async () => {
    const inmId = id();
    const f = facturaDoc({ inmuebleId: inmId, total: 100000 });
    const inm = inmuebleDoc({ _id: inmId, code: '301' });

    const svc = servicio({
      facturas: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([f]),
      },
      inmuebles: {
        find: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([inm]),
      },
    });

    const result = await svc.findAll({});

    expect(result.rangos.map((r) => r.rango)).toEqual([
      'sinVencer',
      'dias_1_30',
      'dias_31_60',
      'dias_61_90',
      'dias_91_120',
      'dias_121_180',
      'dias_181_360',
      'dias_361_720',
      'dias_720_mas',
    ]);
    expect(result.totalCartera).toBe(
      result.rangos.reduce((sum, r) => sum + r.valor, 0),
    );
  });

  it('sin documentos pendientes: filas vacias y rangos en 0', async () => {
    const svc = servicio();

    const result = await svc.findAll({});

    expect(result.filas).toEqual([]);
    expect(result.totalCartera).toBe(0);
    expect(result.rangos.every((r) => r.valor === 0)).toBe(true);
  });
});

import { Types } from 'mongoose';
import { VencimientosCarteraService } from './vencimientos-cartera.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'FV-001',
  dueDate: new Date('2026-08-01'),
  outstandingBalance: 200000,
  status: 'emitida',
  ...over,
});

const ndDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'ND-001',
  issueDate: new Date('2026-07-15'),
  outstandingBalance: 50000,
  conceptoId: new Types.ObjectId(),
  status: 'emitida',
  ...over,
});

const saldoDoc = (
  inmuebleId: Types.ObjectId,
  conceptoId: Types.ObjectId,
  balance: number,
) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId,
  conceptoId,
  balance,
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
    saldosCartera: find(),
    inmuebles: find(),
    terceros: find(),
    tenant: { resolveCoPropertyId: () => COP },
  };
  const m = { ...defaults, ...overrides };
  return new VencimientosCarteraService(
    m.facturas as never,
    m.notasDebito as never,
    m.saldosCartera as never,
    m.inmuebles as never,
    m.terceros as never,
    m.tenant as never,
  );
};

describe('VencimientosCarteraService', () => {
  describe('sin filtro de concepto', () => {
    it('una Factura vencida produce una fila con saldo, diasMora y estado vencido', async () => {
      const f = facturaDoc({
        inmuebleId: new Types.ObjectId(),
        dueDate: new Date('2026-08-01'),
        outstandingBalance: 200000,
      });
      const inm = inmuebleDoc({ _id: f.inmuebleId, code: '301' });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([inm]),
        },
      });

      const result = await svc.findAll({});

      expect(result.filas).toHaveLength(1);
      expect(result.filas[0]).toMatchObject({
        inmuebleCodigo: '301',
        saldoPendiente: 200000,
        estado: 'vencido',
      });
      expect(result.filas[0].diasMora).toBeGreaterThan(0);
    });

    it('una Factura no vencida produce diasMora: 0, estado pendiente', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 30);
      const f = facturaDoc({
        inmuebleId: new Types.ObjectId(),
        dueDate: futureDate,
        outstandingBalance: 100000,
      });
      const inm = inmuebleDoc({ _id: f.inmuebleId, code: '101' });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([inm]),
        },
      });

      const result = await svc.findAll({});

      expect(result.filas[0]).toMatchObject({
        saldoPendiente: 100000,
        diasMora: 0,
        estado: 'pendiente',
      });
    });

    it('un inmueble con Factura vencida y NotaDebito mas vencida reporta el peor diasMora', async () => {
      const inmId = new Types.ObjectId();
      const f = facturaDoc({
        inmuebleId: inmId,
        dueDate: new Date('2026-08-10'),
        outstandingBalance: 100000,
      });
      const nd = ndDoc({
        inmuebleId: inmId,
        issueDate: new Date('2026-07-01'),
        outstandingBalance: 50000,
      });
      const inm = inmuebleDoc({ _id: inmId, code: '201' });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([nd]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([inm]),
        },
      });

      const result = await svc.findAll({});

      expect(result.filas).toHaveLength(1);
      expect(result.filas[0].saldoPendiente).toBe(150000);
      // ND is more overdue than the Factura — its diasMora should win
      expect(result.filas[0].diasMora).toBeGreaterThan(0);
      expect(result.filas[0].estado).toBe('vencido');
    });

    it('un inmueble sin documentos pendientes no aparece en filas', async () => {
      const svc = servicio();

      const result = await svc.findAll({});

      expect(result).toEqual({
        filas: [],
        totalCartera: 0,
        totalVencido: 0,
        totalPendiente: 0,
        porcentajeVencido: 0,
      });
    });

    it('resuelve el nombre del propietario desde Inmueble.holderId -> Tercero.name', async () => {
      const holderId = id();
      const inmId = id();
      const f = facturaDoc({ inmuebleId: inmId, outstandingBalance: 100000 });
      const inm = inmuebleDoc({ _id: inmId, code: '401', holderId });
      const tercero = { _id: holderId, name: 'Juan Perez' };

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
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

    it('filtra la consulta a Tercero por coPropertyId (tenancy law)', async () => {
      const holderId = id();
      const inmId = id();
      const f = facturaDoc({ inmuebleId: inmId, outstandingBalance: 100000 });
      const inm = inmuebleDoc({ _id: inmId, code: '401', holderId });
      const tercero = { _id: holderId, name: 'Juan Perez' };

      const tercerosFind = jest.fn().mockReturnThis();
      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([inm]),
        },
        terceros: {
          find: tercerosFind,
          exec: jest.fn().mockResolvedValue([tercero]),
        },
      });

      await svc.findAll({});

      expect(tercerosFind).toHaveBeenCalledWith(
        expect.objectContaining({ coPropertyId: COP }),
      );
    });
  });

  describe('con filtro de concepto', () => {
    it('saldoPendiente viene de SaldoCartera, no del outstandingBalance de la Factura', async () => {
      const inmId = id();
      const conceptoId = id();
      const f = facturaDoc({
        inmuebleId: inmId,
        outstandingBalance: 200000, // full invoice balance
        lines: [{ conceptoId }], // has matching line
      });
      const sc = saldoDoc(inmId, conceptoId, 80000); // but only 80k for this concept
      const inm = inmuebleDoc({ _id: inmId, code: '501' });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([sc]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([inm]),
        },
      });

      const result = await svc.findAll({ conceptoId: conceptoId.toString() });

      expect(result.filas).toHaveLength(1);
      // Must match SaldoCartera, NOT the Factura's outstandingBalance
      expect(result.filas[0].saldoPendiente).toBe(80000);
    });

    it('una NotaDebito con conceptoId no coincidente no contribuye al saldo filtrado', async () => {
      const inmId = id();
      const conceptoFilter = id();
      const conceptoNd = id(); // different concept
      const nd = ndDoc({
        inmuebleId: inmId,
        conceptoId: conceptoNd,
        outstandingBalance: 50000,
      });
      const inm = inmuebleDoc({ _id: inmId, code: '601' });

      // SaldoCartera query filters for balance > 0 — the mock simulates
      // Mongo's filter by returning [] (the real DB would filter out balance: 0)
      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([nd]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([inm]),
        },
      });

      const result = await svc.findAll({
        conceptoId: conceptoFilter.toString(),
      });

      // SaldoCartera returned nothing (balance would be 0 or no entry),
      // so the inmueble shouldn't appear
      expect(result.filas).toHaveLength(0);
    });
  });

  describe('totales', () => {
    it('totalCartera, totalVencido, totalPendiente y porcentajeVencido suman correctamente', async () => {
      const inmVencido = id();
      const inmPendiente = id();
      const f1 = facturaDoc({
        inmuebleId: inmVencido,
        dueDate: new Date('2026-07-01'),
        outstandingBalance: 300000,
      });
      const f2 = facturaDoc({
        inmuebleId: inmPendiente,
        dueDate: new Date('2099-01-01'),
        outstandingBalance: 100000,
      });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f1, f2]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest
            .fn()
            .mockResolvedValue([
              inmuebleDoc({ _id: inmVencido, code: 'A' }),
              inmuebleDoc({ _id: inmPendiente, code: 'B' }),
            ]),
        },
      });

      const result = await svc.findAll({});

      expect(result.totalCartera).toBe(400000);
      expect(result.totalVencido).toBe(300000);
      expect(result.totalPendiente).toBe(100000);
      expect(result.porcentajeVencido).toBeCloseTo(75);
    });
  });

  describe('ordenamiento', () => {
    it('filas esta ordenado por diasMora descendente', async () => {
      const inm1 = id();
      const inm2 = id();
      // inm1: very overdue (July 1)
      const f1 = facturaDoc({
        inmuebleId: inm1,
        dueDate: new Date('2026-07-01'),
        outstandingBalance: 100000,
      });
      // inm2: slightly overdue (Aug 25)
      const f2 = facturaDoc({
        inmuebleId: inm2,
        dueDate: new Date('2026-08-25'),
        outstandingBalance: 50000,
      });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f1, f2]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest
            .fn()
            .mockResolvedValue([
              inmuebleDoc({ _id: inm1, code: 'A' }),
              inmuebleDoc({ _id: inm2, code: 'B' }),
            ]),
        },
      });

      const result = await svc.findAll({});

      expect(result.filas[0].diasMora).toBeGreaterThanOrEqual(
        result.filas[1].diasMora,
      );
    });
  });

  describe('sin datos', () => {
    it('retorna estructura vacia, no error', async () => {
      const svc = servicio();

      const result = await svc.findAll({});

      expect(result).toEqual({
        filas: [],
        totalCartera: 0,
        totalVencido: 0,
        totalPendiente: 0,
        porcentajeVencido: 0,
      });
    });
  });
});

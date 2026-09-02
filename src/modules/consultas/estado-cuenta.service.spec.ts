import { Types } from 'mongoose';
import { EstadoCuentaService } from './estado-cuenta.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  issueDate: new Date('2026-01-15'),
  dueDate: new Date('2026-02-01'),
  periodStart: new Date('2026-01-01'),
  periodEnd: new Date('2026-01-31'),
  fullNumber: 'FV-001-001',
  total: 200000,
  status: 'emitida',
  ...over,
});

const reciboDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  fullNumber: 'RC-001-001',
  ...over,
});

const ncDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  fullNumber: 'NC-001-001',
  ...over,
});

const ntDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  fullNumber: 'NT-001-001',
  description: 'Reclasificación',
  monto: 50000,
  status: 'activo',
  createdAt: new Date('2026-01-20'),
  ...over,
});

const appDoc = (
  sourceId: Types.ObjectId,
  sourceType: 'RC' | 'NC',
  over: Record<string, unknown> = {},
) => ({
  _id: id(),
  coPropertyId: COP,
  sourceType,
  sourceId,
  documentType: 'FV' as const,
  documentId: id(),
  amountApplied: 0,
  status: 'activa',
  appliedAt: new Date('2026-01-25'),
  ...over,
});

const mockFind = (data: unknown[] = []) => ({
  find: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  findOne: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(data),
});

const mockFindById = (data: unknown = null) => ({
  findById: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(data),
});

const servicio = (overrides: Record<string, unknown> = {}) =>
  new EstadoCuentaService(
    (overrides.facturas ?? mockFind()) as never,
    (overrides.recibos ?? mockFind()) as never,
    (overrides.notasCredito ?? mockFind()) as never,
    (overrides.notasDebito ?? mockFind()) as never,
    (overrides.notasContables ?? mockFind()) as never,
    (overrides.aplicaciones ?? mockFind()) as never,
    (overrides.inmuebles ?? mockFindById()) as never,
    (overrides.terceros ?? mockFindById()) as never,
    (overrides.copropiedades ?? mockFindById()) as never,
    { resolveCoPropertyId: () => COP } as never,
  );

const svcDefaults = (overrides: Record<string, unknown> = {}) => ({
  inmuebles: mockFindById({ code: '301', holderId: null }),
  terceros: mockFindById(null),
  copropiedades: mockFindById({ phone: null, email: null }),
  ...overrides,
});

describe('EstadoCuentaService', () => {
  describe('findPeriodos', () => {
    it('returns distinct periods sorted most-recent-first', async () => {
      const f1 = facturaDoc({
        periodStart: new Date('2026-01-01'),
        periodEnd: new Date('2026-01-31'),
      });
      const f2 = facturaDoc({
        periodStart: new Date('2025-12-01'),
        periodEnd: new Date('2025-12-31'),
      });

      const svc = servicio({
        facturas: mockFind([f1, f2]),
      });

      const result = await svc.findPeriodos(id().toString());

      expect(result).toHaveLength(2);
      expect(result[0].periodStart).toBe('2026-01-01T00:00:00.000Z');
      expect(result[1].periodStart).toBe('2025-12-01T00:00:00.000Z');
    });

    it('returns empty array when inmueble has no facturas', async () => {
      const svc = servicio();
      const result = await svc.findPeriodos(id().toString());
      expect(result).toEqual([]);
    });
  });

  describe('findAll', () => {
    it('saldoAnterior sums movements strictly before periodStart', async () => {
      const inmId = id();
      const fId = id();
      const rId = id();
      const f = facturaDoc({
        _id: fId,
        inmuebleId: inmId,
        total: 200000,
        issueDate: new Date('2025-12-15'),
      });
      const r = reciboDoc({ _id: rId });
      const app = appDoc(rId, 'RC', {
        amountApplied: 50000,
        appliedAt: new Date('2025-12-20'),
      });

      const svc = servicio({
        facturas: mockFind([f]),
        recibos: mockFind([r]),
        aplicaciones: mockFind([app]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      // Before 2026-01-01: FC 200k - RC 50k = 150k
      expect(result.saldoAnterior).toBe(150000);
    });

    it('Recibo application produces categoria pago', async () => {
      const inmId = id();
      const fId = id();
      const rId = id();
      const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
      const r = reciboDoc({ _id: rId });
      const app = appDoc(rId, 'RC', {
        amountApplied: 30000,
        appliedAt: new Date('2026-01-20'),
      });

      const svc = servicio({
        facturas: mockFind([f]),
        recibos: mockFind([r]),
        aplicaciones: mockFind([app]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      const pagoRow = result.movimientos.find((m) => m.categoria === 'pago');
      expect(pagoRow).toBeDefined();
      expect(pagoRow!.abono).toBe(30000);
      expect(result.pagosRecibidos).toBe(30000);
      expect(result.descuentosAjustes).toBe(0);
    });

    it('NC application produces categoria descuento', async () => {
      const inmId = id();
      const fId = id();
      const ncId = id();
      const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
      const nc = ncDoc({ _id: ncId });
      const app = appDoc(ncId, 'NC', {
        amountApplied: 20000,
        appliedAt: new Date('2026-01-22'),
      });

      const svc = servicio({
        facturas: mockFind([f]),
        notasCredito: mockFind([nc]),
        aplicaciones: mockFind([app]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      const descRow = result.movimientos.find(
        (m) => m.categoria === 'descuento',
      );
      expect(descRow).toBeDefined();
      expect(descRow!.abono).toBe(20000);
      expect(result.descuentosAjustes).toBe(20000);
      expect(result.pagosRecibidos).toBe(0);
    });

    it('Nota Contable paired rows have categoria null and contribute to neither summary', async () => {
      const inmId = id();
      const fId = id();
      const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
      const nt = ntDoc();

      const svc = servicio({
        facturas: mockFind([f]),
        notasContables: mockFind([nt]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      const ntRows = result.movimientos.filter((m) => m.categoria === null && m.concepto === 'Reclasificación');
      expect(ntRows).toHaveLength(2);
      expect(result.pagosRecibidos).toBe(0);
      expect(result.descuentosAjustes).toBe(0);
      expect(
        result.saldoAnterior +
          result.cargosDelMes -
          result.pagosRecibidos -
          result.descuentosAjustes,
      ).toBe(result.saldoActual);
    });

    it('estado is al_dia when saldoActual <= 0', async () => {
      const inmId = id();
      const fId = id();
      const rId = id();
      const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
      const r = reciboDoc({ _id: rId });
      const app = appDoc(rId, 'RC', {
        amountApplied: 100000,
        appliedAt: new Date('2026-01-20'),
      });

      const svc = servicio({
        facturas: mockFind([f]),
        recibos: mockFind([r]),
        aplicaciones: mockFind([app]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      expect(result.estado).toBe('al_dia');
      expect(result.saldoActual).toBe(0);
    });

    it('movimientos excludes rows outside period window', async () => {
      const inmId = id();
      const fId = id();
      const fId2 = id();
      const rId = id();
      // FC inside the window
      const fInside = facturaDoc({
        _id: fId,
        inmuebleId: inmId,
        total: 100000,
        issueDate: new Date('2026-01-15'),
      });
      // FC before the window (only affects saldoAnterior)
      const fBefore = facturaDoc({
        _id: fId2,
        inmuebleId: inmId,
        total: 100000,
        issueDate: new Date('2025-12-01'),
      });
      const r = reciboDoc({ _id: rId });
      // RC app before the window
      const app = appDoc(rId, 'RC', {
        amountApplied: 30000,
        appliedAt: new Date('2025-12-20'),
      });

      const svc = servicio({
        facturas: mockFind([fInside, fBefore]),
        recibos: mockFind([r]),
        aplicaciones: mockFind([app]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      // Only the inside-FC appears in movimientos
      expect(result.movimientos).toHaveLength(1);
      expect(result.movimientos[0].cargo).toBe(100000);
      // saldoAnterior counts before-FC (100k) and before-RC (-30k) = 70k
      expect(result.saldoAnterior).toBe(70000);
    });

    it('propietario is null when inmueble has no holderId', async () => {
      const inmId = id();
      const f = facturaDoc({ inmuebleId: inmId, total: 0 });

      const svc = servicio({
        facturas: mockFind([f]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      expect(result.propietario).toBeNull();
    });

    it('copropiedad contact fields reflect actual values', async () => {
      const inmId = id();
      const f = facturaDoc({ inmuebleId: inmId, total: 0 });

      const svc = servicio({
        facturas: mockFind([f]),
        ...svcDefaults({
          copropiedades: mockFindById({
            phone: '601-555-1234',
            email: 'admin@cop.com',
          }),
        }),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      expect(result.copropiedadTelefono).toBe('601-555-1234');
      expect(result.copropiedadEmail).toBe('admin@cop.com');
    });
  });
});

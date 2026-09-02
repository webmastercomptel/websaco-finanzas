import { Types } from 'mongoose';
import { MovimientoContableService } from './movimiento-contable.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const HOLDER = new Types.ObjectId();
const id = () => new Types.ObjectId();

const asientoDoc = (anchorField: string, anchorId: Types.ObjectId, over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  date: new Date('2026-08-15'),
  entries: [
    { account: '1355-01', type: 'debito', amount: 100000, description: 'Administración' },
    { account: '4135-01', type: 'credito', amount: 100000, description: 'Ingresos' },
  ],
  loteId: null,
  [anchorField]: anchorId,
  reciboId: anchorField === 'reciboId' ? anchorId : null,
  notaCreditoId: anchorField === 'notaCreditoId' ? anchorId : null,
  notaDebitoId: anchorField === 'notaDebitoId' ? anchorId : null,
  notaContableId: anchorField === 'notaContableId' ? anchorId : null,
  ...over,
});

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  fullNumber: 'FV-001',
  ...over,
});

const reciboDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  fullNumber: 'RC-001',
  ...over,
});

const inmuebleDoc = (over: Record<string, unknown> = {}) => ({
  _id: INMUEBLE,
  coPropertyId: COP,
  code: '301',
  holderId: HOLDER,
  ...over,
});

const terceroDoc = (over: Record<string, unknown> = {}) => ({
  _id: HOLDER,
  coPropertyId: COP,
  name: 'Juan Perez',
  identificationNumber: '900123456',
  identificationVerificationDigit: '7',
  ...over,
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const find = (data: unknown[] = []) => ({
    find: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(data),
  });
  const findOne = (data: unknown = null) => ({
    findOne: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(data),
  });
  const defaults: Record<string, unknown> = {
    asientos: find(),
    facturas: find(),
    recibos: find(),
    notasCredito: find(),
    notasDebito: find(),
    notasContables: find(),
    inmuebles: findOne(inmuebleDoc()),
    terceros: findOne(terceroDoc()),
    tenant: { resolveCoPropertyId: () => COP },
  };
  const m = { ...defaults, ...overrides };
  return new MovimientoContableService(
    m.asientos as never,
    m.facturas as never,
    m.recibos as never,
    m.notasCredito as never,
    m.notasDebito as never,
    m.notasContables as never,
    m.inmuebles as never,
    m.terceros as never,
    m.tenant as never,
  );
};

describe('MovimientoContableService', () => {
  describe('buscar', () => {
    it('resolves the AsientoContable anchored to a Factura via fullNumber', async () => {
      const f = facturaDoc();
      const asiento = asientoDoc('facturaId', f._id);

      const svc = servicio({
        facturas: {
          findOne: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(f),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([asiento]),
        },
      });

      const result = await svc.buscar({ tipoDocumento: 'FC', numeroCompleto: 'FV-001' });

      expect(result.movimientos).toHaveLength(1);
      expect(result.movimientos[0].tipoDocumento).toBe('FC');
      expect(result.movimientos[0].numeroDocumento).toBe('FV-001');
    });

    it('returns both AsientoContable entries when a Recibo posted twice', async () => {
      const rec = reciboDoc();
      const a1 = asientoDoc('reciboId', rec._id, { date: new Date('2026-08-10') });
      const a2 = asientoDoc('reciboId', rec._id, { date: new Date('2026-08-15') });

      const svc = servicio({
        recibos: {
          findOne: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(rec),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([a1, a2]),
        },
      });

      const result = await svc.buscar({ tipoDocumento: 'RC', numeroCompleto: 'RC-001' });

      expect(result.movimientos).toHaveLength(2);
      expect(result.movimientos[0].fecha).toBe(new Date('2026-08-10').toISOString());
      expect(result.movimientos[1].fecha).toBe(new Date('2026-08-15').toISOString());
    });

    it('returns empty movimientos for a non-existent document number', async () => {
      const svc = servicio({
        facturas: {
          findOne: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(null),
        },
      });

      const result = await svc.buscar({ tipoDocumento: 'FC', numeroCompleto: 'FV-999' });

      expect(result.movimientos).toEqual([]);
    });

    it('includes inmuebleCodigo, propietario, and nit in the result', async () => {
      const f = facturaDoc();
      const asiento = asientoDoc('facturaId', f._id);

      const svc = servicio({
        facturas: {
          findOne: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(f),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([asiento]),
        },
      });

      const result = await svc.buscar({ tipoDocumento: 'FC', numeroCompleto: 'FV-001' });

      expect(result.movimientos[0].inmuebleCodigo).toBe('301');
      expect(result.movimientos[0].propietario).toBe('Juan Perez');
      expect(result.movimientos[0].nit).toBe('900123456-7');
    });

    it('null propietario when inmueble has no holder', async () => {
      const f = facturaDoc();
      const asiento = asientoDoc('facturaId', f._id);

      const svc = servicio({
        facturas: {
          findOne: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(f),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([asiento]),
        },
        inmuebles: {
          findOne: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(inmuebleDoc({ holderId: null })),
        },
      });

      const result = await svc.buscar({ tipoDocumento: 'FC', numeroCompleto: 'FV-001' });

      expect(result.movimientos[0].propietario).toBeNull();
      expect(result.movimientos[0].nit).toBeNull();
    });
  });

  describe('findAll', () => {
    it('returns asientos for an inmueble within a date range', async () => {
      const f = facturaDoc();
      const asiento = asientoDoc('facturaId', f._id);

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([asiento]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toHaveLength(1);
      expect(result.movimientos[0].tipoDocumento).toBe('FC');
    });

    it('excludes asientos dated outside the range', async () => {
      const f = facturaDoc();
      // asiento dated outside [desde, hasta]
      const asiento = asientoDoc('facturaId', f._id, { date: new Date('2025-06-01') });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]), // date filter excludes it
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toEqual([]);
    });

    it('returns empty when no documents exist for the inmueble', async () => {
      const svc = servicio();

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toEqual([]);
    });

    it('a voided Recibo reversal appears in the listing', async () => {
      const rec = reciboDoc();
      // Two asientos for the same Recibo: create + void reversal
      const a1 = asientoDoc('reciboId', rec._id, { date: new Date('2026-08-10') });
      const a2 = asientoDoc('reciboId', rec._id, { date: new Date('2026-08-20') });

      const svc = servicio({
        recibos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([rec]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([a1, a2]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toHaveLength(2);
      expect(result.movimientos[0].fecha).toBe(new Date('2026-08-10').toISOString());
      expect(result.movimientos[1].fecha).toBe(new Date('2026-08-20').toISOString());
    });
  });
});

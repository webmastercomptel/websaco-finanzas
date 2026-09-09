import { Types } from 'mongoose';
import { MovimientoContableService } from './movimiento-contable.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const asientoDoc = (
  anchorField: string,
  anchorId: Types.ObjectId,
  over: Record<string, unknown> = {},
) => ({
  _id: id(),
  coPropertyId: COP,
  date: new Date('2026-08-15'),
  entries: [
    {
      account: '1355-01',
      type: 'debito',
      amount: 100000,
      description: 'Administración',
    },
    {
      account: '4135-01',
      type: 'credito',
      amount: 100000,
      description: 'Ingresos',
    },
  ],
  loteId: null,
  [anchorField]: anchorId,
  facturaId: anchorField === 'facturaId' ? anchorId : null,
  reciboId: anchorField === 'reciboId' ? anchorId : null,
  notaCreditoId: anchorField === 'notaCreditoId' ? anchorId : null,
  notaDebitoId: anchorField === 'notaDebitoId' ? anchorId : null,
  notaContableId: anchorField === 'notaContableId' ? anchorId : null,
  notaAnticipoId: anchorField === 'notaAnticipoId' ? anchorId : null,
  ...over,
});

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'FV-001',
  ...over,
});

const reciboDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'RC-001',
  ...over,
});

const inmuebleDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  code: '301',
  holderId: null,
  ...over,
});

const terceroDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  name: 'Juan Perez',
  identificationNumber: '900123456',
  identificationVerificationDigit: '7',
  ...over,
});

const cuentaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  code: '1355-01',
  name: 'CxC Administracion',
  ...over,
});

const find = (data: unknown[] = []) => ({
  find: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(data),
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const defaults: Record<string, unknown> = {
    asientos: find(),
    facturas: find(),
    recibos: find(),
    notasCredito: find(),
    notasDebito: find(),
    notasContables: find(),
    notasAnticipo: find(),
    inmuebles: find(),
    terceros: find(),
    cuentasContables: find(),
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
    m.notasAnticipo as never,
    m.inmuebles as never,
    m.terceros as never,
    m.cuentasContables as never,
    m.tenant as never,
  );
};

describe('MovimientoContableService', () => {
  describe('findAll', () => {
    it('returns every asiento in the coproperty within a date range, regardless of inmueble', async () => {
      const f1 = facturaDoc({ fullNumber: 'FV-001' });
      const f2 = facturaDoc({ fullNumber: 'FV-002' });
      const a1 = asientoDoc('facturaId', f1._id);
      const a2 = asientoDoc('facturaId', f2._id, {
        date: new Date('2026-08-16'),
      });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f1, f2]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([a1, a2]),
        },
      });

      const result = await svc.findAll({
        desde: '2026-08-01',
        hasta: '2026-08-31',
      });

      expect(result.movimientos).toHaveLength(2);
      expect(result.movimientos.map((m) => m.numeroDocumento).sort()).toEqual([
        'FV-001',
        'FV-002',
      ]);
    });

    it('passes a date range filter to AsientoContable.find, scoped only by coPropertyId', async () => {
      const asientosFind = jest.fn().mockReturnThis();

      const svc = servicio({
        asientos: {
          find: asientosFind,
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(asientosFind).toHaveBeenCalledWith({
        coPropertyId: COP,
        date: { $gte: new Date('2026-01-01'), $lte: new Date('2026-12-31') },
      });
      expect(result.movimientos).toEqual([]);
    });

    it('includes entries anchored to different document types and different inmuebles', async () => {
      const f = facturaDoc({ fullNumber: 'FV-001' });
      const nc = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: id(),
        fullNumber: 'NC-001',
      };
      const asientoFactura = asientoDoc('facturaId', f._id, {
        date: new Date('2026-08-05'),
      });
      const asientoNC = asientoDoc('notaCreditoId', nc._id, {
        date: new Date('2026-08-10'),
      });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasCredito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([nc]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([asientoFactura, asientoNC]),
        },
      });

      const result = await svc.findAll({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toHaveLength(2);
      expect(result.movimientos.map((m) => m.tipoDocumento).sort()).toEqual([
        'FC',
        'NC',
      ]);
      expect(
        result.movimientos.find((m) => m.tipoDocumento === 'NC')
          ?.numeroDocumento,
      ).toBe('NC-001');
    });

    it('resuelve el ancla notaAnticipoId como tipoDocumento NA', async () => {
      const na = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: id(),
        fullNumber: 'NA-001',
      };
      const asientoNA = asientoDoc('notaAnticipoId', na._id, {
        date: new Date('2026-08-12'),
      });

      const svc = servicio({
        notasAnticipo: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([na]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([asientoNA]),
        },
      });

      const result = await svc.findAll({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toHaveLength(1);
      expect(result.movimientos[0].tipoDocumento).toBe('NA');
      expect(result.movimientos[0].numeroDocumento).toBe('NA-001');
    });

    it('returns empty when no asientos exist in the range', async () => {
      const svc = servicio();

      const result = await svc.findAll({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toEqual([]);
    });

    it('resolves inmuebleCodigo/propietario per asiento, even across different inmuebles', async () => {
      const inm1 = id();
      const inm2 = id();
      const holder1 = id();
      const f1 = facturaDoc({ fullNumber: 'FV-001', inmuebleId: inm1 });
      const f2 = facturaDoc({ fullNumber: 'FV-002', inmuebleId: inm2 });
      const a1 = asientoDoc('facturaId', f1._id);
      const a2 = asientoDoc('facturaId', f2._id);

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f1, f2]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([a1, a2]),
        },
        inmuebles: {
          find: jest.fn().mockReturnThis(),
          exec: jest
            .fn()
            .mockResolvedValue([
              inmuebleDoc({ _id: inm1, code: '301', holderId: holder1 }),
              inmuebleDoc({ _id: inm2, code: '302', holderId: null }),
            ]),
        },
        terceros: {
          find: jest.fn().mockReturnThis(),
          exec: jest
            .fn()
            .mockResolvedValue([
              terceroDoc({ _id: holder1, name: 'Juan Perez' }),
            ]),
        },
      });

      const result = await svc.findAll({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      const m1 = result.movimientos.find((m) => m.numeroDocumento === 'FV-001');
      const m2 = result.movimientos.find((m) => m.numeroDocumento === 'FV-002');
      expect(m1).toMatchObject({
        inmuebleCodigo: '301',
        propietario: 'Juan Perez',
      });
      expect(m2).toMatchObject({ inmuebleCodigo: '302', propietario: null });
    });

    it('resuelve nombreCuenta desde el catalogo de cuentas contables', async () => {
      const f = facturaDoc();
      const asiento = asientoDoc('facturaId', f._id);

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([asiento]),
        },
        cuentasContables: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([cuentaDoc()]),
        },
      });

      const result = await svc.findAll({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      const linea1355 = result.movimientos[0].lineas.find(
        (l) => l.cuenta === '1355-01',
      );
      expect(linea1355?.nombreCuenta).toBe('CxC Administracion');
      // No chart entry for 4135-01 — falls back to the code.
      const linea4135 = result.movimientos[0].lineas.find(
        (l) => l.cuenta === '4135-01',
      );
      expect(linea4135?.nombreCuenta).toBe('4135-01');
    });

    it('a voided Recibo reversal appears in the listing, sorted by date', async () => {
      const rec = reciboDoc();
      const a1 = asientoDoc('reciboId', rec._id, {
        date: new Date('2026-08-10'),
      });
      const a2 = asientoDoc('reciboId', rec._id, {
        date: new Date('2026-08-20'),
      });

      const svc = servicio({
        recibos: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([rec]),
        },
        asientos: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([a1, a2]),
        },
      });

      const result = await svc.findAll({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toHaveLength(2);
      expect(result.movimientos[0].fecha).toBe(
        new Date('2026-08-10').toISOString(),
      );
      expect(result.movimientos[1].fecha).toBe(
        new Date('2026-08-20').toISOString(),
      );
    });
  });
});

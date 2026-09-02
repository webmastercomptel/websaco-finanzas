import { Types } from 'mongoose';
import { MovimientoContableService } from './movimiento-contable.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const HOLDER = new Types.ObjectId();
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

      const result = await svc.buscar({
        tipoDocumento: 'FC',
        numeroCompleto: 'FV-001',
      });

      expect(result.movimientos).toHaveLength(1);
      expect(result.movimientos[0].tipoDocumento).toBe('FC');
      expect(result.movimientos[0].numeroDocumento).toBe('FV-001');
    });

    it('returns both AsientoContable entries when a Recibo posted twice', async () => {
      const rec = reciboDoc();
      const a1 = asientoDoc('reciboId', rec._id, {
        date: new Date('2026-08-10'),
      });
      const a2 = asientoDoc('reciboId', rec._id, {
        date: new Date('2026-08-15'),
      });

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

      const result = await svc.buscar({
        tipoDocumento: 'RC',
        numeroCompleto: 'RC-001',
      });

      expect(result.movimientos).toHaveLength(2);
      expect(result.movimientos[0].fecha).toBe(
        new Date('2026-08-10').toISOString(),
      );
      expect(result.movimientos[1].fecha).toBe(
        new Date('2026-08-15').toISOString(),
      );
    });

    it('returns empty movimientos for a non-existent document number', async () => {
      const svc = servicio({
        facturas: {
          findOne: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(null),
        },
      });

      const result = await svc.buscar({
        tipoDocumento: 'FC',
        numeroCompleto: 'FV-999',
      });

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

      const result = await svc.buscar({
        tipoDocumento: 'FC',
        numeroCompleto: 'FV-001',
      });

      expect(result.movimientos[0].inmuebleCodigo).toBe('301');
      expect(result.movimientos[0].propietario).toBe('Juan Perez');
      expect(result.movimientos[0].nit).toBe('900123456-7');
    });

    it('resolves Inmueble and Tercero scoped to coPropertyId, never by bare _id', async () => {
      // Regression guard named in AGENTS.md: a prior test in this codebase kept
      // its name and shape while its assertion was quietly weakened from
      // checking `coPropertyId` to checking `_id` alone, silently accepting a
      // `findOne({_id})`-without-tenant-filter regression. Asserting on the
      // exact call args (not just the resolved value) is what actually catches it.
      const f = facturaDoc();
      const asiento = asientoDoc('facturaId', f._id);
      const inmueblesFindOne = jest.fn().mockReturnThis();
      const tercerosFindOne = jest.fn().mockReturnThis();

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
          findOne: inmueblesFindOne,
          exec: jest.fn().mockResolvedValue(inmuebleDoc()),
        },
        terceros: {
          findOne: tercerosFindOne,
          exec: jest.fn().mockResolvedValue(terceroDoc()),
        },
      });

      await svc.buscar({ tipoDocumento: 'FC', numeroCompleto: 'FV-001' });

      expect(inmueblesFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: INMUEBLE, coPropertyId: COP }),
      );
      expect(tercerosFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: HOLDER, coPropertyId: COP }),
      );
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

      const result = await svc.buscar({
        tipoDocumento: 'FC',
        numeroCompleto: 'FV-001',
      });

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

    it('passes a date range filter to AsientoContable.find (excludes out-of-range entries)', async () => {
      const f = facturaDoc();
      const asientosFind = jest.fn().mockReturnThis();

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        asientos: {
          find: asientosFind,
          sort: jest.fn().mockReturnThis(),
          // the real Mongo query applies the date filter server-side; here we
          // simulate that by resolving [] and instead assert the filter
          // actually SENT to find() carries the date clause — a mock that
          // just resolves [] regardless of the filter would pass even if
          // this clause were deleted from the service.
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(asientosFind).toHaveBeenCalledWith(
        expect.objectContaining({
          date: { $gte: new Date('2026-01-01'), $lte: new Date('2026-12-31') },
        }),
      );
      expect(result.movimientos).toEqual([]);
    });

    it('includes entries anchored to different document types for the same inmueble ($or across anchor fields)', async () => {
      const f = facturaDoc();
      const nc = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: INMUEBLE,
        fullNumber: 'NC-001',
      };
      const asientoFactura = asientoDoc('facturaId', f._id, {
        date: new Date('2026-08-05'),
      });
      const asientoNC = asientoDoc('notaCreditoId', nc._id, {
        date: new Date('2026-08-10'),
      });
      const asientosFind = jest.fn().mockReturnThis();

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasCredito: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([nc]),
        },
        asientos: {
          find: asientosFind,
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([asientoFactura, asientoNC]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      // Both anchor types must actually reach the $or filter, not just the mapped result —
      // a bug that dropped the NC branch of orConditions would still pass a
      // result-only assertion since the mock ignores its filter argument.
      const llamadas = asientosFind.mock.calls as unknown[][];
      const filtroEnviado = llamadas[0][0] as { $or: unknown[] };
      expect(filtroEnviado.$or).toEqual(
        expect.arrayContaining([
          { facturaId: { $in: [f._id] } },
          { notaCreditoId: { $in: [nc._id] } },
        ]),
      );
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
      const a1 = asientoDoc('reciboId', rec._id, {
        date: new Date('2026-08-10'),
      });
      const a2 = asientoDoc('reciboId', rec._id, {
        date: new Date('2026-08-20'),
      });

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
      expect(result.movimientos[0].fecha).toBe(
        new Date('2026-08-10').toISOString(),
      );
      expect(result.movimientos[1].fecha).toBe(
        new Date('2026-08-20').toISOString(),
      );
    });
  });
});

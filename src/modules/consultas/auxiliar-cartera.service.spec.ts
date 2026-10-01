import { Types } from 'mongoose';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();

const id = () => new Types.ObjectId();

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  copropiedadId: COP,
  inmuebleId: INMUEBLE,
  numeroCompleto: 'FV-001',
  fechaEmision: new Date('2026-08-01'),
  total: 200000,
  estado: 'emitida',
  ...over,
});

const reciboDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  copropiedadId: COP,
  inmuebleId: INMUEBLE,
  numeroCompleto: 'RC-001',
  ...over,
});

const ndDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  copropiedadId: COP,
  inmuebleId: INMUEBLE,
  numeroCompleto: 'ND-001',
  fechaEmision: new Date('2026-08-15'),
  total: 50000,
  descripcion: 'Cargo por mora',
  estado: 'emitida',
  ...over,
});

const ntDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  copropiedadId: COP,
  inmuebleId: INMUEBLE,
  numeroCompleto: 'NT-001',
  monto: 30000,
  descripcion: 'Reclasificación de intereses',
  estado: 'activo',
  createdAt: new Date('2026-08-20'),
  ...over,
});

const notaAnticipoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  copropiedadId: COP,
  inmuebleId: INMUEBLE,
  numeroCompleto: 'NA-001',
  ...over,
});

const aplicacionDoc = (
  sourceId: Types.ObjectId,
  documentoId: Types.ObjectId,
  over: Record<string, unknown> = {},
) => ({
  _id: id(),
  copropiedadId: COP,
  sourceType: 'RC',
  sourceId,
  tipoDocumento: 'FV',
  documentoId,
  montoAplicado: 100000,
  aplicadoEn: new Date('2026-08-10'),
  estado: 'activa',
  ...over,
});

const find = (data: unknown[] = []) => ({
  find: jest.fn().mockReturnThis(),
  findOne: jest
    .fn()
    .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
  exec: jest.fn().mockResolvedValue(data),
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const defaults: Record<string, unknown> = {
    facturas: find(),
    recibos: find(),
    notasCredito: find(),
    notasDebito: find(),
    notasContables: find(),
    notasAnticipo: find(),
    aplicaciones: find(),
    inmuebles: find(),
    terceros: find(),
    tenant: { resolveCoPropertyId: () => COP },
    saldosIniciales: find(),
  };
  const m = { ...defaults, ...overrides };
  return new AuxiliarCarteraService(
    m.facturas as never,
    m.recibos as never,
    m.notasCredito as never,
    m.notasDebito as never,
    m.notasContables as never,
    m.notasAnticipo as never,
    m.aplicaciones as never,
    m.inmuebles as never,
    m.terceros as never,
    m.tenant as never,
    m.saldosIniciales as never,
  );
};

describe('AuxiliarCarteraService', () => {
  describe('rows por tipo', () => {
    it('una Factura produce una fila Débito', async () => {
      const f = facturaDoc();
      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toHaveLength(1);
      expect(result.movimientos[0]).toMatchObject({
        tipo: 'FC',
        numeroCompleto: 'FV-001',
        debito: 200000,
        credito: null,
      });
    });

    it('una Factura anulada TAMBIÉN produce su fila Débito — es un kardex histórico, nunca se filtra por status', async () => {
      const f = facturaDoc({ estado: 'anulada' });
      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toHaveLength(1);
      expect(result.movimientos[0]).toMatchObject({
        tipo: 'FC',
        numeroCompleto: 'FV-001',
        debito: 200000,
        credito: null,
      });
    });

    it('una Nota Débito produce una fila Débito con su description', async () => {
      const nd = ndDoc();
      const svc = servicio({
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([nd]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos[0]).toMatchObject({
        tipo: 'ND',
        concepto: 'Cargo por mora',
        debito: 50000,
      });
    });

    it('un Recibo aplicando a 3 facturas produce 3 filas Crédito separadas', async () => {
      const rec = reciboDoc();
      const f1 = facturaDoc({ numeroCompleto: 'FV-001' });
      const f2 = facturaDoc({ numeroCompleto: 'FV-002' });
      const f3 = facturaDoc({ numeroCompleto: 'FV-003' });
      const apps = [
        aplicacionDoc(rec._id, f1._id, { montoAplicado: 50000 }),
        aplicacionDoc(rec._id, f2._id, { montoAplicado: 30000 }),
        aplicacionDoc(rec._id, f3._id, { montoAplicado: 20000 }),
      ];

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f1, f2, f3]),
        },
        recibos: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([rec]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(apps),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      const creditoRows = result.movimientos.filter((m) => m.credito !== null);
      expect(creditoRows).toHaveLength(3);
      expect(creditoRows.map((r) => r.refCruce)).toEqual([
        'FV-001',
        'FV-002',
        'FV-003',
      ]);
    });

    it('usa Recibo.receivedDate como fecha del movimiento, no AplicacionCartera.appliedAt', async () => {
      // Bug real reportado: un Recibo digitado con fecha 02/06/2026 (mucho
      // antes del instante real del servidor) mostraba su cruce con la
      // fecha de HOY en el Auxiliar de Cartera — porque el cruce corre en
      // el instante real (`appliedAt`), nunca en la fecha que el usuario
      // declaró para el pago.
      const rec = reciboDoc({ fechaRecibo: new Date('2026-06-02') });
      const f = facturaDoc();
      const app = aplicacionDoc(rec._id, f._id, {
        aplicadoEn: new Date('2026-09-09'),
      });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        recibos: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([rec]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([app]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-06-01',
        hasta: '2026-06-30',
      });

      const fila = result.movimientos.find((m) => m.tipo === 'RC');
      expect(fila).toBeDefined();
      expect(fila!.fecha).toBe('2026-06-02T00:00:00.000Z');
    });

    it('una Nota de Anticipo aplicando a una factura produce una fila Crédito NA (el anticipo se aplicó después del recibo, no desde el propio recibo)', async () => {
      const na = notaAnticipoDoc();
      const f = facturaDoc();
      const app = aplicacionDoc(na._id, f._id, {
        sourceType: 'NA',
        montoAplicado: 75000,
      });

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasAnticipo: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([na]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([app]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      const fila = result.movimientos.find((m) => m.tipo === 'NA');
      expect(fila).toMatchObject({
        numeroCompleto: 'NA-001',
        concepto: 'Nota de Anticipo NA-001',
        refCruce: 'FV-001',
        credito: 75000,
      });
    });

    it('una Nota Contable produce exactamente 2 filas (débito destino, crédito origen), net zero', async () => {
      const nt = ntDoc();
      const svc = servicio({
        notasContables: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([nt]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos).toHaveLength(2);
      const debitos = result.movimientos.filter((m) => m.debito !== null);
      const creditos = result.movimientos.filter((m) => m.credito !== null);
      expect(debitos).toHaveLength(1);
      expect(creditos).toHaveLength(1);
      expect(debitos[0].debito).toBe(30000);
      expect(creditos[0].credito).toBe(30000);
      // Net zero effect on saldoFinal
      expect(result.saldoFinal).toBe(0);
    });

    it('una Nota Contable usa su propia issueDate, NUNCA createdAt — bug real reportado: una nota fechada en junio aparecía en septiembre', async () => {
      const nt = ntDoc({
        fecha: new Date('2026-06-10'),
        createdAt: new Date('2026-09-14'),
      });
      const svc = servicio({
        notasContables: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([nt]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result.movimientos[0].fecha).toBe(
        new Date('2026-06-10').toISOString(),
      );
    });
  });

  describe('saldoInicial', () => {
    it('suma movimientos anteriores a `desde`', async () => {
      const f = facturaDoc({
        fechaEmision: new Date('2026-06-01'),
        total: 100000,
      });
      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-08-01',
        hasta: '2026-12-31',
      });

      expect(result.saldoInicial).toBe(100000);
      // The factura is BEFORE `desde`, so it should not appear in movimientos
      expect(result.movimientos).toHaveLength(0);
    });
  });

  describe('documentos anulados/revertidos', () => {
    it('una AplicacionCartera revertida no produce fila', async () => {
      const rec = reciboDoc();
      const f = facturaDoc();

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        recibos: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([rec]),
        },
        // The service queries status:'activa' — Mongo would filter out reverted
        // ones, so the mock returns [] (simulating an empty result set).
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      const creditoRows = result.movimientos.filter((m) => m.credito !== null);
      expect(creditoRows).toHaveLength(0);
    });
  });

  describe('inmueble sin movimientos', () => {
    it('retorna estructura vacía, no error', async () => {
      const svc = servicio();

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result).toMatchObject({
        saldoInicial: 0,
        movimientos: [],
        totalDebitos: 0,
        totalCreditos: 0,
        saldoFinal: 0,
      });
    });
  });

  describe('período devuelto', () => {
    it('devuelve el día "hasta" pedido, no el instante extendido al fin del día en Colombia (bug real: 31/07 salía como 01/08)', async () => {
      const svc = servicio();

      const result = await svc.findAll({
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-07-01',
        hasta: '2026-07-31',
      });

      expect(result.desde).toBe('2026-07-01T00:00:00.000Z');
      expect(result.hasta).toBe('2026-07-31T00:00:00.000Z');
    });
  });
});

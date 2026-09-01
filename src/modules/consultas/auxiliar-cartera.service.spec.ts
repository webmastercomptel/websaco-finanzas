import { Types } from 'mongoose';
import { AuxiliarCarteraService } from './auxiliar-cartera.service';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();

const id = () => new Types.ObjectId();

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  fullNumber: 'FV-001',
  issueDate: new Date('2026-08-01'),
  total: 200000,
  status: 'emitida',
  ...over,
});

const reciboDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  fullNumber: 'RC-001',
  ...over,
});

const ndDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  fullNumber: 'ND-001',
  issueDate: new Date('2026-08-15'),
  total: 50000,
  description: 'Cargo por mora',
  status: 'emitida',
  ...over,
});

const ntDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: INMUEBLE,
  fullNumber: 'NT-001',
  monto: 30000,
  description: 'Reclasificación de intereses',
  status: 'activo',
  createdAt: new Date('2026-08-20'),
  ...over,
});

const aplicacionDoc = (
  sourceId: Types.ObjectId,
  documentId: Types.ObjectId,
  over: Record<string, unknown> = {},
) => ({
  _id: id(),
  coPropertyId: COP,
  sourceType: 'RC',
  sourceId,
  documentType: 'FV',
  documentId,
  amountApplied: 100000,
  appliedAt: new Date('2026-08-10'),
  status: 'activa',
  ...over,
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const find = (data: unknown[] = []) => ({
    find: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(data),
  });
  const defaults: Record<string, unknown> = {
    facturas: find(),
    recibos: find(),
    notasCredito: find(),
    notasDebito: find(),
    notasContables: find(),
    aplicaciones: find(),
    tenant: { resolveCoPropertyId: () => COP },
  };
  const m = { ...defaults, ...overrides };
  return new AuxiliarCarteraService(
    m.facturas as never,
    m.recibos as never,
    m.notasCredito as never,
    m.notasDebito as never,
    m.notasContables as never,
    m.aplicaciones as never,
    m.tenant as never,
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
      const f1 = facturaDoc({ fullNumber: 'FV-001' });
      const f2 = facturaDoc({ fullNumber: 'FV-002' });
      const f3 = facturaDoc({ fullNumber: 'FV-003' });
      const apps = [
        aplicacionDoc(rec._id, f1._id, { amountApplied: 50000 }),
        aplicacionDoc(rec._id, f2._id, { amountApplied: 30000 }),
        aplicacionDoc(rec._id, f3._id, { amountApplied: 20000 }),
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
  });

  describe('filtro de tipos no afecta el saldo', () => {
    it('saldoFinal es identico con tipos [FC,RC] o solo [FC]', async () => {
      const f = facturaDoc({ total: 200000 });
      const rec = reciboDoc();
      const app = aplicacionDoc(rec._id, f._id, { amountApplied: 100000 });

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

      const base = {
        inmuebleId: INMUEBLE.toString(),
        desde: '2026-01-01',
        hasta: '2026-12-31',
      };

      const resultAll = await svc.findAll({ ...base, tipos: ['FC', 'RC'] });
      const resultFC = await svc.findAll({ ...base, tipos: ['FC'] });

      expect(resultAll.saldoFinal).toBe(resultFC.saldoFinal);
      expect(resultAll.saldoInicial).toBe(resultFC.saldoInicial);

      // El chequeo que el spec pide explícitamente y que la versión anterior
      // de este test no hacía: no solo los totales agregados, sino el
      // `saldo` de la MISMA fila (la factura FC) tiene que ser idéntico en
      // ambas respuestas — si la implementación filtrara por `tipos` ANTES
      // de acumular el saldo corriente en vez de después, esta fila
      // mostraría un número distinto según qué tipos estén tildados, que es
      // exactamente el bug que esta regla evita.
      const facturaEnAll = resultAll.movimientos.find((m) => m.tipo === 'FC');
      const facturaEnFC = resultFC.movimientos.find((m) => m.tipo === 'FC');
      expect(facturaEnAll).toBeDefined();
      expect(facturaEnFC).toBeDefined();
      expect(facturaEnAll!.saldo).toBe(facturaEnFC!.saldo);

      // Y con solo [RC] tildado, la fila RC que SÍ se devuelve también debe
      // reportar el mismo `saldo` corriente — la fila oculta (FC) igual
      // participó del cálculo.
      const resultRC = await svc.findAll({ ...base, tipos: ['RC'] });
      const rcEnAll = resultAll.movimientos.find((m) => m.tipo === 'RC');
      const rcEnRC = resultRC.movimientos.find((m) => m.tipo === 'RC');
      expect(rcEnAll).toBeDefined();
      expect(rcEnRC).toBeDefined();
      expect(rcEnAll!.saldo).toBe(rcEnRC!.saldo);
    });
  });

  describe('saldoInicial', () => {
    it('suma movimientos anteriores a `desde`', async () => {
      const f = facturaDoc({
        issueDate: new Date('2026-06-01'),
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

      expect(result).toEqual({
        saldoInicial: 0,
        movimientos: [],
        totalDebitos: 0,
        totalCreditos: 0,
        saldoFinal: 0,
      });
    });
  });
});

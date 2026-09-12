import { Types } from 'mongoose';
import { ConciliacionCarteraService } from './conciliacion-cartera.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

type Doc = Record<string, unknown>;

/** Bare-bones stand-in for a Mongo query filter's `$gte`/`$lte`/`$in`. */
function coincideValor(valor: unknown, condicion: unknown): boolean {
  if (
    condicion !== null &&
    typeof condicion === 'object' &&
    ('$gte' in condicion || '$lte' in condicion)
  ) {
    const rango = condicion as { $gte?: Date; $lte?: Date };
    const fecha = valor as Date | null;
    if (fecha == null) return false;
    if (rango.$gte && fecha < rango.$gte) return false;
    if (rango.$lte && fecha > rango.$lte) return false;
    return true;
  }
  if (
    condicion !== null &&
    typeof condicion === 'object' &&
    '$in' in condicion
  ) {
    const opciones = (condicion as { $in: unknown[] }).$in.map(String);
    return opciones.includes(String(valor));
  }
  return valor === condicion;
}

function coincide(doc: Doc, filtro: Doc): boolean {
  return Object.entries(filtro).every(([campo, condicion]) => {
    if (campo === '$or') {
      const opciones = condicion as Doc[];
      return opciones.some((sub) => coincide(doc, sub));
    }
    return coincideValor(doc[campo], condicion);
  });
}

/**
 * A real-enough in-memory Mongo model: `find(filtro)` actually filters `docs`
 * by comparing `$gte`/`$lte`/`$in` conditions the way MongoDB would, instead
 * of a fixed canned response — required here because `findAll` queries the
 * SAME collection (facturas, notasDebito, aplicaciones) with several
 * different filter shapes in one call (via `calcularDocumentosConSaldoAFecha`
 * called twice with different cut-off dates, plus this service's own
 * concept-row queries), and a canned mock can't tell those calls apart.
 */
interface ColeccionQuery {
  sort: () => ColeccionQuery;
  exec: () => Promise<Doc[]>;
}

function coleccion(docs: Doc[]) {
  const find = jest.fn((filtro: Doc) => {
    const data = docs.filter((d) => coincide(d, filtro));
    const q: ColeccionQuery = {
      sort: jest.fn(() => q),
      exec: jest.fn().mockResolvedValue(data),
    };
    return q;
  });
  return { find };
}

const facturaDoc = (over: Doc = {}): Doc => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  number: 1,
  fullNumber: 'FV1',
  issueDate: new Date('2026-09-10'),
  dueDate: new Date('2026-10-01'),
  total: 100000,
  status: 'emitida',
  ...over,
});

const notaDebitoDoc = (over: Doc = {}): Doc => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  number: 1,
  fullNumber: 'ND1',
  issueDate: new Date('2026-09-05'),
  total: 50000,
  status: 'emitida',
  voidedAt: null,
  ...over,
});

const notaContableDoc = (over: Doc = {}): Doc => ({
  _id: id(),
  coPropertyId: COP,
  number: 1,
  fullNumber: 'NT1',
  monto: 20000,
  status: 'activo',
  createdAt: new Date('2026-09-12'),
  ...over,
});

const reciboDoc = (over: Doc = {}): Doc => ({
  _id: id(),
  coPropertyId: COP,
  number: 1,
  fullNumber: 'RC1',
  receivedDate: new Date('2026-09-15'),
  status: 'activo',
  voidedAt: null,
  ...over,
});

const ncDoc = (over: Doc = {}): Doc => ({
  _id: id(),
  coPropertyId: COP,
  number: 1,
  fullNumber: 'NC1',
  issueDate: new Date('2026-09-15'),
  status: 'activo',
  voidedAt: null,
  ...over,
});

const appDoc = (
  sourceId: Types.ObjectId,
  sourceType: 'RC' | 'NC' | 'NA',
  over: Doc = {},
): Doc => ({
  _id: id(),
  coPropertyId: COP,
  sourceType,
  sourceId,
  documentType: 'FV' as const,
  documentId: id(),
  amountApplied: 0,
  discountApplied: 0,
  status: 'activa',
  appliedAt: new Date('2026-09-15'),
  revertedAt: null,
  ...over,
});

const saldoCarteraDoc = (balance: number, over: Doc = {}): Doc => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  conceptoId: id(),
  balance,
  ...over,
});

const servicio = (
  data: {
    facturas?: Doc[];
    recibos?: Doc[];
    notasCredito?: Doc[];
    notasDebito?: Doc[];
    notasContables?: Doc[];
    notasAnticipo?: Doc[];
    aplicaciones?: Doc[];
    saldosCartera?: Doc[];
  } = {},
) =>
  new ConciliacionCarteraService(
    coleccion(data.facturas ?? []) as never,
    coleccion(data.recibos ?? []) as never,
    coleccion(data.notasCredito ?? []) as never,
    coleccion(data.notasDebito ?? []) as never,
    coleccion(data.notasContables ?? []) as never,
    coleccion(data.notasAnticipo ?? []) as never,
    coleccion(data.aplicaciones ?? []) as never,
    coleccion(data.saldosCartera ?? []) as never,
    { resolveCoPropertyId: () => COP } as never,
  );

const PERIODO = {
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-09-30T23:59:59.999Z',
};

describe('ConciliacionCarteraService', () => {
  describe('findPeriodos', () => {
    it('returns distinct periods across the WHOLE coproperty, sorted most-recent-first', async () => {
      // Unlike Estado de Cuenta, no inmuebleId to filter by — two different
      // inmuebles billed in the same lote must collapse into one period.
      const f1 = facturaDoc({
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
      });
      const f2 = facturaDoc({
        inmuebleId: id(),
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
      });
      const f3 = facturaDoc({
        periodStart: new Date('2026-08-01'),
        periodEnd: new Date('2026-08-31'),
      });

      const svc = servicio({ facturas: [f1, f2, f3] });
      const result = await svc.findPeriodos();

      expect(result).toEqual([
        {
          periodStart: '2026-09-01T00:00:00.000Z',
          periodEnd: '2026-09-30T00:00:00.000Z',
        },
        {
          periodStart: '2026-08-01T00:00:00.000Z',
          periodEnd: '2026-08-31T00:00:00.000Z',
        },
      ]);
    });

    it('returns empty array when the coproperty has no facturas', async () => {
      const svc = servicio();
      expect(await svc.findPeriodos()).toEqual([]);
    });
  });

  describe('findAll', () => {
    it('reconciles to zero when a Factura and its full Recibo application are the only movements', async () => {
      const fId = id();
      const rId = id();
      const f = facturaDoc({ _id: fId, total: 100000 });
      const r = reciboDoc({ _id: rId });
      const app = appDoc(rId, 'RC', {
        documentId: fId,
        amountApplied: 30000,
        appliedAt: new Date('2026-09-20'),
      });

      const svc = servicio({
        facturas: [f],
        recibos: [r],
        aplicaciones: [app],
        // saldoCarteraReal is read straight from SaldoCartera, never
        // recomputed from the documents above — set here to match what the
        // arithmetic side produces, proving the two independent sources
        // agree.
        saldosCartera: [saldoCarteraDoc(70000)],
      });

      const result = await svc.findAll(PERIODO);

      expect(result.saldoAnterior).toBe(0);
      expect(result.totalDebito).toBe(100000);
      expect(result.totalCredito).toBe(30000);
      expect(result.saldoCarteraCalculado).toBe(70000);
      expect(result.saldoCarteraReal).toBe(70000);
      expect(result.diferencia).toBe(0);
    });

    it('saldoCarteraReal sums SaldoCartera.balance across every inmueble/concepto, never a fresh reconstruction', async () => {
      // Two rows (different inmueble/concepto) must both count — and a
      // Factura/aplicación fixture that would reconstruct to a DIFFERENT
      // number proves this isn't secretly derived from those documents.
      const svc = servicio({
        facturas: [facturaDoc({ total: 999999 })],
        saldosCartera: [saldoCarteraDoc(40000), saldoCarteraDoc(30000)],
      });

      const result = await svc.findAll(PERIODO);

      expect(result.saldoCarteraReal).toBe(70000);
    });

    it('credits the FULL amountApplied, never subtracting discountApplied', async () => {
      // Regression: an earlier version mirrored Estado de Cuenta's cash-vs-
      // descuento split and excluded discountApplied from the credit here,
      // which under-counts totalCredito and produces a false diferencia,
      // since calcularDocumentosConSaldoAFecha reduces the balance by the
      // FULL amountApplied regardless of how much of it was a discount.
      const fId = id();
      const rId = id();
      const f = facturaDoc({ _id: fId, total: 400000 });
      const r = reciboDoc({ _id: rId });
      const app = appDoc(rId, 'RC', {
        documentId: fId,
        amountApplied: 400000,
        discountApplied: 40000,
        appliedAt: new Date('2026-09-20'),
      });

      const svc = servicio({
        facturas: [f],
        recibos: [r],
        aplicaciones: [app],
      });

      const result = await svc.findAll(PERIODO);

      expect(result.totalCredito).toBe(400000);
      expect(result.diferencia).toBe(0);
    });

    it('Facturación row sums totals and reports the first/last fullNumber by number order', async () => {
      const f1 = facturaDoc({ number: 1, fullNumber: 'FV1', total: 50000 });
      const f2 = facturaDoc({ number: 167, fullNumber: 'FV167', total: 60000 });

      const svc = servicio({ facturas: [f1, f2] });
      const result = await svc.findAll(PERIODO);

      const fila = result.conceptos.find((c) => c.concepto === 'facturacion');
      expect(fila).toMatchObject({
        desde: 'FV1',
        hasta: 'FV167',
        valorDebito: 110000,
        valorCredito: 0,
      });
    });

    it('a Factura outside the period only affects saldoAnterior, not the Facturación row', async () => {
      const antes = facturaDoc({
        fullNumber: 'FV-antes',
        issueDate: new Date('2026-08-15'),
        total: 20000,
      });

      const svc = servicio({ facturas: [antes] });
      const result = await svc.findAll(PERIODO);

      expect(result.saldoAnterior).toBe(20000);
      const fila = result.conceptos.find((c) => c.concepto === 'facturacion');
      expect(fila).toMatchObject({ desde: null, hasta: null, valorDebito: 0 });
    });

    it("Anulación de Recibos de Caja is keyed by the Recibo's own voidedAt", async () => {
      const fId = id();
      const rId = id();
      const f = facturaDoc({ _id: fId, total: 100000 });
      // Received last month, voided THIS period.
      const r = reciboDoc({
        _id: rId,
        receivedDate: new Date('2026-08-20'),
        status: 'anulado',
        voidedAt: new Date('2026-09-10'),
      });
      const app = appDoc(rId, 'RC', {
        documentId: fId,
        amountApplied: 30000,
        status: 'revertida',
      });

      const svc = servicio({
        facturas: [f],
        recibos: [r],
        aplicaciones: [app],
      });

      const result = await svc.findAll(PERIODO);

      const ingresos = result.conceptos.find(
        (c) => c.concepto === 'recibos_caja',
      );
      const anulacion = result.conceptos.find(
        (c) => c.concepto === 'anulacion_recibos_caja',
      );
      expect(ingresos).toMatchObject({ valorCredito: 0 });
      expect(anulacion).toMatchObject({
        desde: 'RC1',
        hasta: 'RC1',
        valorDebito: 30000,
      });
    });

    it('Notas Crédito credit the full amountApplied under notas_credito', async () => {
      const fId = id();
      const ncId = id();
      const f = facturaDoc({ _id: fId, total: 100000 });
      const nc = ncDoc({ _id: ncId });
      const app = appDoc(ncId, 'NC', {
        documentId: fId,
        amountApplied: 15000,
        appliedAt: new Date('2026-09-18'),
      });

      const svc = servicio({
        facturas: [f],
        notasCredito: [nc],
        aplicaciones: [app],
      });

      const result = await svc.findAll(PERIODO);

      const fila = result.conceptos.find((c) => c.concepto === 'notas_credito');
      expect(fila).toMatchObject({
        desde: 'NC1',
        hasta: 'NC1',
        valorCredito: 15000,
      });
    });

    it('Notas Débito are débito; their anulación (voidedAt in period) is crédito', async () => {
      const emitida = notaDebitoDoc({ fullNumber: 'ND1', total: 50000 });
      const anulada = notaDebitoDoc({
        fullNumber: 'ND2',
        total: 20000,
        status: 'anulada',
        voidedAt: new Date('2026-09-22'),
      });

      const svc = servicio({ notasDebito: [emitida, anulada] });
      const result = await svc.findAll(PERIODO);

      const debito = result.conceptos.find(
        (c) => c.concepto === 'notas_debito',
      );
      const anulacion = result.conceptos.find(
        (c) => c.concepto === 'anulacion_notas_debito',
      );
      expect(debito).toMatchObject({ valorDebito: 50000, valorCredito: 0 });
      expect(anulacion).toMatchObject({ valorDebito: 0, valorCredito: 20000 });
    });

    it('Notas Contables post the same total as both débito and crédito (net zero)', async () => {
      const nt = notaContableDoc({ monto: 20000 });

      const svc = servicio({ notasContables: [nt] });
      const result = await svc.findAll(PERIODO);

      const fila = result.conceptos.find(
        (c) => c.concepto === 'notas_contables',
      );
      expect(fila).toMatchObject({
        desde: 'NT1',
        hasta: 'NT1',
        valorDebito: 20000,
        valorCredito: 20000,
      });
      // Net zero — doesn't move totalDebito ahead of totalCredito on its own.
      expect(result.totalDebito).toBe(result.totalCredito);
    });

    it('reconciles when the previous balance comes from a Factura issued before the period', async () => {
      // A Factura from a prior period, paid down partly THIS period — proves
      // saldoAnterior (computed as of the instant before periodStart, via
      // the historical-reconstruction utility) and the period's own credit
      // row (computed independently, via AplicacionCartera) combine to the
      // same number the SaldoCartera table reports, even though the two
      // sides never share a code path.
      const fId = id();
      const rId = id();
      const fAntes = facturaDoc({
        _id: fId,
        issueDate: new Date('2026-08-01'),
        total: 100000,
      });
      const r = reciboDoc({ _id: rId });
      const app = appDoc(rId, 'RC', {
        documentId: fId,
        amountApplied: 30000,
        appliedAt: new Date('2026-09-05'),
      });

      const svc = servicio({
        facturas: [fAntes],
        recibos: [r],
        aplicaciones: [app],
        saldosCartera: [saldoCarteraDoc(70000)],
      });

      const result = await svc.findAll(PERIODO);

      expect(result.saldoAnterior).toBe(100000);
      expect(result.totalCredito).toBe(30000);
      expect(result.saldoCarteraCalculado).toBe(70000);
      expect(result.saldoCarteraReal).toBe(70000);
      expect(result.diferencia).toBe(0);
    });

    it('saldoAnterior refleja un Recibo cuya fecha de negocio cae en el período previo aunque se haya digitado tarde (bug real reportado: la conciliación de julio quedó con diferencia)', async () => {
      // Escenario: Factura de mayo (antes de junio). Un Recibo con
      // receivedDate 15-jun (dentro de junio, el período ANTERIOR a julio)
      // paga 30000 de esa factura — pero se digitó tarde: su
      // AplicacionCartera.appliedAt real es 5-jul, ya cerrado junio.
      // `calcularDocumentosConSaldoAFecha` (saldoAnterior) usa hoy
      // `appliedAt`, así que como de fecha de corte (fin de junio)
      // `appliedAt` (5-jul) es POSTERIOR, el pago no se resta — saldoAnterior
      // sale 100000 en vez de 70000. La fila "Ingresos por Recibos de Caja"
      // de julio tampoco lo recoge (su receivedDate es junio, no julio) —
      // el crédito de 30000 desaparece de la conciliación de julio por
      // completo, aunque SaldoCartera (real) sí lo tiene aplicado.
      const fId = id();
      const rId = id();
      const fAntes = facturaDoc({
        _id: fId,
        issueDate: new Date('2026-05-10'),
        total: 100000,
      });
      const r = reciboDoc({ _id: rId, receivedDate: new Date('2026-06-15') });
      const app = appDoc(rId, 'RC', {
        documentId: fId,
        amountApplied: 30000,
        appliedAt: new Date('2026-07-05'),
        sourceDate: new Date('2026-06-15'),
      });

      const svc = servicio({
        facturas: [fAntes],
        recibos: [r],
        aplicaciones: [app],
        saldosCartera: [saldoCarteraDoc(70000)],
      });

      const result = await svc.findAll({
        periodStart: '2026-07-01T00:00:00.000Z',
        periodEnd: '2026-07-31T23:59:59.999Z',
      });

      expect(result.saldoAnterior).toBe(70000);
      expect(result.saldoCarteraCalculado).toBe(70000);
      expect(result.saldoCarteraReal).toBe(70000);
      expect(result.diferencia).toBe(0);
    });

    it('surfaces a non-zero diferencia when SaldoCartera has drifted from the documents', async () => {
      // The whole point of the report: if the cache and the ledger disagree,
      // diferencia must say so, not silently average them out.
      const f = facturaDoc({ total: 100000 });

      const svc = servicio({
        facturas: [f],
        saldosCartera: [saldoCarteraDoc(70000)],
      });

      const result = await svc.findAll(PERIODO);

      expect(result.saldoCarteraCalculado).toBe(100000);
      expect(result.saldoCarteraReal).toBe(70000);
      expect(result.diferencia).toBe(30000);
    });
  });
});

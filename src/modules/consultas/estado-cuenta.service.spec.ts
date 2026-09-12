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
  lines: [{}],
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

/** For `inmuebles`/`terceros` — both now resolved via `findOne({_id, coPropertyId})`. */
const mockFindOne = (data: unknown = null) => ({
  findOne: jest.fn().mockReturnThis(),
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
    // `unappliedAmount` no longer lives on the Recibo itself — resolved
    // live from `SaldoDocumentoOrigen` (see that schema's own docblock).
    // Empty by default: only the "anticipos" test below needs candidate
    // rows here, and it builds its own to match its own Recibo fixtures.
    (overrides.saldoDocumentoOrigen ?? mockFind()) as never,
    (overrides.inmuebles ?? mockFindOne()) as never,
    (overrides.terceros ?? mockFindOne()) as never,
    (overrides.copropiedades ?? mockFindById()) as never,
    { resolveCoPropertyId: () => COP } as never,
  );

const svcDefaults = (overrides: Record<string, unknown> = {}) => ({
  inmuebles: mockFindOne({ code: '301', holderId: null }),
  terceros: mockFindOne(null),
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

    it("sorts by the real periodStart field, not a typo'd name", async () => {
      const facturas = mockFind([facturaDoc()]);
      const svc = servicio({ facturas });

      await svc.findPeriodos(id().toString());

      // Mongo would silently ignore a sort key that doesn't exist on the
      // document (returning insertion order instead) — this asserts the
      // actual field name passed to .sort(), not just the mocked result.
      expect(facturas.sort).toHaveBeenCalledWith({ periodStart: -1 });
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

    it("el concepto de una Factura es 'N Cargos del mes FV-xxx', N según la cantidad de líneas", async () => {
      const inmId = id();
      const f = facturaDoc({
        inmuebleId: inmId,
        fullNumber: 'FV-0012',
        total: 300000,
        lines: [{}, {}, {}],
      });

      const svc = servicio({
        facturas: mockFind([f]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      expect(result.movimientos[0].concepto).toBe('3 Cargos del mes FV-0012');
    });

    it('el descuento por pronto pago de un Recibo va a descuentosAjustes, NUNCA a pagosRecibidos', async () => {
      // Bug real reportado: un Recibo con descuento por pronto pago activo
      // (amountApplied 400000 = 360000 de efectivo real + 40000 de
      // descuento) sumaba el descuento completo a "Pagos Recibidos" — el
      // propietario nunca pagó esos 40000, así que deben verse como
      // descuento, no como plata recibida.
      const inmId = id();
      const fId = id();
      const rId = id();
      const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 400000 });
      const r = reciboDoc({ _id: rId });
      const app = appDoc(rId, 'RC', {
        amountApplied: 400000,
        discountApplied: 40000,
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

      expect(result.pagosRecibidos).toBe(360000);
      expect(result.descuentosAjustes).toBe(40000);
      const filaDescuento = result.movimientos.find((m) =>
        m.concepto.includes('Descuento Pronto Pago'),
      );
      expect(filaDescuento).toMatchObject({
        abono: 40000,
        categoria: 'descuento',
      });
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

    it('usa Recibo.receivedDate como fecha del movimiento, no AplicacionCartera.appliedAt', async () => {
      // Bug real reportado: se liquida un lote de octubre y se elabora un
      // Recibo #12 con receivedDate en octubre, pero el cruce corre en el
      // instante real del servidor (appliedAt en septiembre) — el Estado de
      // Cuenta de octubre debía mostrar el pago y no lo hacía porque
      // filtraba/mostraba por appliedAt en vez de la fecha del Recibo.
      const inmId = id();
      const fId = id();
      const rId = id();
      const f = facturaDoc({ _id: fId, inmuebleId: inmId, total: 100000 });
      const r = reciboDoc({ _id: rId, receivedDate: new Date('2026-10-01') });
      const app = appDoc(rId, 'RC', {
        amountApplied: 100000,
        appliedAt: new Date('2026-09-09'),
      });

      const svc = servicio({
        facturas: mockFind([f]),
        recibos: mockFind([r]),
        aplicaciones: mockFind([app]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-10-01T00:00:00.000Z',
        periodEnd: '2026-10-31T23:59:59.999Z',
      });

      const pagoRow = result.movimientos.find((m) => m.categoria === 'pago');
      expect(pagoRow).toBeDefined();
      expect(pagoRow!.fecha).toBe('2026-10-01T00:00:00.000Z');
      expect(result.pagosRecibidos).toBe(100000);
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

      const ntRows = result.movimientos.filter(
        (m) => m.categoria === null && m.concepto === 'Reclasificación',
      );
      expect(ntRows).toHaveLength(2);
      expect(result.pagosRecibidos).toBe(0);
      expect(result.descuentosAjustes).toBe(0);
      // Direct assertion, not derived from the same formula saldoActual
      // uses — cargosDelMes must reflect ONLY the Factura (100k), never
      // the Nota Contable's débito row (50k), even though that row's
      // `cargo` field is non-null. Without this, a bug that lets the NT
      // row leak into cargosDelMes is invisible: the formula below would
      // still balance internally (both sides shift by the same amount).
      expect(result.cargosDelMes).toBe(100000);
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

    it("fechaEmision and vencimiento come from the period's own Factura", async () => {
      const inmId = id();
      const f = facturaDoc({
        inmuebleId: inmId,
        total: 100000,
        periodStart: new Date('2026-01-01T00:00:00.000Z'),
        periodEnd: new Date('2026-01-31T23:59:59.999Z'),
        issueDate: new Date('2026-01-15'),
        dueDate: new Date('2026-02-01'),
      });

      // `find()` (the general fetch, step 1) must return the array; `findOne()`
      // (the period's own Factura lookup) must return the single document —
      // a shared mock returning the same shape for both would hide a real
      // bug here, since `facturaPeriodo?.issueDate` on an array is `undefined`.
      const facturasMock = {
        find: jest.fn().mockReturnThis(),
        findOne: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        exec: jest
          .fn()
          .mockResolvedValueOnce(f) // findOne().exec() — awaited first in the service
          .mockResolvedValueOnce([f]), // find().exec() — step 1, awaited second
      };

      const svc = servicio({
        facturas: facturasMock,
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      // Must be the Factura's real issueDate/dueDate — NOT periodStart/
      // periodEnd echoed back (the bug a typo'd query field would produce,
      // since findOne would never match and fall through to that fallback).
      expect(result.fechaEmision).toBe('2026-01-15T00:00:00.000Z');
      expect(result.vencimiento).toBe('2026-02-01T00:00:00.000Z');
    });

    it('filtra la consulta a Inmueble y Tercero por coPropertyId (tenancy law)', async () => {
      const inmId = id();
      const holderId = id();
      const f = facturaDoc({ inmuebleId: inmId, total: 0 });

      const inmueblesFindOne = jest.fn().mockReturnThis();
      const tercerosFindOne = jest.fn().mockReturnThis();

      const svc = servicio({
        facturas: mockFind([f]),
        inmuebles: {
          findOne: inmueblesFindOne,
          exec: jest.fn().mockResolvedValue({ code: '301', holderId }),
        },
        terceros: {
          findOne: tercerosFindOne,
          exec: jest.fn().mockResolvedValue({ name: 'Juan Perez' }),
        },
        copropiedades: mockFindById({ phone: null, email: null }),
      });

      await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      expect(inmueblesFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ coPropertyId: COP }),
      );
      expect(tercerosFindOne).toHaveBeenCalledWith(
        expect.objectContaining({ coPropertyId: COP }),
      );
    });

    it('anticipos lista los Recibos activos con unappliedAmount > 0, sin importar el período consultado', async () => {
      const inmId = id();
      // Con anticipo, dentro de otro mes — debe salir igual: es un saldo
      // vivo, no un movimiento del período.
      const rConAnticipo = reciboDoc({
        fullNumber: 'RC-0011',
        status: 'activo',
        receivedDate: new Date('2026-06-02'),
        unappliedAmount: 180200,
      });
      // Sin saldo pendiente — no debe salir.
      const rSinAnticipo = reciboDoc({
        fullNumber: 'RC-0009',
        status: 'activo',
        receivedDate: new Date('2026-05-01'),
        unappliedAmount: 0,
      });
      // Anulado — nunca es un anticipo disponible, aunque quedara
      // unappliedAmount > 0 sin limpiar.
      const rAnulado = reciboDoc({
        fullNumber: 'RC-0007',
        status: 'anulado',
        receivedDate: new Date('2026-04-01'),
        unappliedAmount: 50000,
      });

      const svc = servicio({
        recibos: mockFind([rConAnticipo, rSinAnticipo, rAnulado]),
        // Live source of each Recibo's pending balance — only the activos
        // are ever looked up here (`rAnulado` is filtered out before this
        // query runs), so its own `unappliedAmount` above is irrelevant.
        saldoDocumentoOrigen: mockFind([
          { documentoId: rConAnticipo._id, saldoDisponible: 180200 },
          { documentoId: rSinAnticipo._id, saldoDisponible: 0 },
        ]),
        ...svcDefaults(),
      });

      const result = await svc.findAll({
        inmuebleId: inmId.toString(),
        periodStart: '2026-01-01T00:00:00.000Z',
        periodEnd: '2026-01-31T23:59:59.999Z',
      });

      expect(result.anticipos).toEqual([
        {
          numeroCompleto: 'RC-0011',
          fecha: '2026-06-02T00:00:00.000Z',
          monto: 180200,
        },
      ]);
    });
  });
});

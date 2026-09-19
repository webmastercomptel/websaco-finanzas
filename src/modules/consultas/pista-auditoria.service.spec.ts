import { Types } from 'mongoose';
import { PistaAuditoriaService } from './pista-auditoria.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  loteId: id(),
  inmuebleId: id(),
  fullNumber: 'FV-001',
  total: 200000,
  status: 'emitida',
  voidedAt: null,
  voidedBy: null,
  createdAt: new Date('2026-08-01T10:00:00.000Z'),
  ...over,
});

const loteDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  generatedBy: id(),
  ...over,
});

const reciboDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'RC-001',
  receivedAmount: 100000,
  status: 'activo',
  generatedBy: id(),
  voidedAt: null,
  voidedBy: null,
  createdAt: new Date('2026-08-05T15:30:00.000Z'),
  ...over,
});

const notaCreditoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'NC-001',
  totalAmount: 30000,
  status: 'activo',
  generatedBy: id(),
  voidedAt: null,
  voidedBy: null,
  createdAt: new Date('2026-08-06T10:00:00.000Z'),
  ...over,
});

const notaDebitoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'ND-001',
  total: 40000,
  status: 'emitida',
  generatedBy: id(),
  voidedAt: null,
  voidedBy: null,
  createdAt: new Date('2026-08-07T10:00:00.000Z'),
  ...over,
});

const notaContableDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'NT-001',
  monto: 15000,
  status: 'activo',
  generatedBy: id(),
  voidedAt: null,
  voidedBy: null,
  createdAt: new Date('2026-08-08T10:00:00.000Z'),
  ...over,
});

const notaAnticipoDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  fullNumber: 'NA-001',
  appliedAmount: 25000,
  status: 'activo',
  generatedBy: id(),
  voidedAt: null,
  voidedBy: null,
  createdAt: new Date('2026-08-09T10:00:00.000Z'),
  ...over,
});

const accountDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  fullName: 'Sin Nombre',
  ...over,
});

const inmuebleDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  code: '301',
  ...over,
});

const find = (data: unknown[] = []) => ({
  find: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(data),
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const defaults: Record<string, unknown> = {
    facturas: find(),
    lotes: find(),
    recibos: find(),
    notasCredito: find(),
    notasDebito: find(),
    notasContables: find(),
    notasAnticipo: find(),
    accounts: find(),
    inmuebles: find(),
    tenant: { resolveCoPropertyId: () => COP },
  };
  const m = { ...defaults, ...overrides };
  return new PistaAuditoriaService(
    m.facturas as never,
    m.lotes as never,
    m.recibos as never,
    m.notasCredito as never,
    m.notasDebito as never,
    m.notasContables as never,
    m.notasAnticipo as never,
    m.accounts as never,
    m.inmuebles as never,
    m.tenant as never,
  );
};

describe('PistaAuditoriaService', () => {
  it('resolves a Factura event actor via its LoteFacturacion.generatedBy, not a field on the Factura', async () => {
    const loteId = id();
    const creadorId = id();
    const inmId = id();
    const f = facturaDoc({ loteId, inmuebleId: inmId, fullNumber: 'FV-100' });
    const lote = loteDoc({ _id: loteId, generatedBy: creadorId });
    const creador = accountDoc({ _id: creadorId, fullName: 'Ana Pérez' });
    const inm = inmuebleDoc({ _id: inmId, code: '501' });

    const svc = servicio({
      facturas: find([f]),
      lotes: find([lote]),
      accounts: find([creador]),
      inmuebles: find([inm]),
    });

    const result = await svc.findAll({});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      accion: 'crear',
      tipoDocumento: 'Factura',
      numeroCompleto: 'FV-100',
      usuarioId: creadorId.toString(),
      usuarioNombre: 'Ana Pérez',
      inmuebleCodigo: '501',
      valor: 200000,
      href: `/facturas/${f._id.toString()}`,
    });
  });

  it('merges creation events from all 6 in-scope document types into one feed', async () => {
    const svc = servicio({
      facturas: find([facturaDoc()]),
      recibos: find([reciboDoc()]),
      notasCredito: find([notaCreditoDoc()]),
      notasDebito: find([notaDebitoDoc()]),
      notasContables: find([notaContableDoc()]),
      notasAnticipo: find([notaAnticipoDoc()]),
    });

    const result = await svc.findAll({});

    const tipos = result.items.map((e) => e.tipoDocumento).sort();
    expect(tipos).toEqual(
      [
        'Factura',
        'Nota Contable',
        'Nota Crédito',
        'Nota Débito',
        'Nota de Anticipo',
        'Recibo',
      ].sort(),
    );
  });

  it('a voided document produces two independent events: crear and anular', async () => {
    const creadorId = id();
    const anuladorId = id();
    const r = reciboDoc({
      status: 'anulado',
      generatedBy: creadorId,
      voidedBy: anuladorId,
      voidedAt: new Date('2026-08-10T09:00:00.000Z'),
      createdAt: new Date('2026-08-05T15:30:00.000Z'),
    });
    const creador = accountDoc({ _id: creadorId, fullName: 'Creador' });
    const anulador = accountDoc({ _id: anuladorId, fullName: 'Anulador' });

    const svc = servicio({
      recibos: find([r]),
      accounts: find([creador, anulador]),
    });

    const result = await svc.findAll({});

    expect(result.total).toBe(2);
    const crear = result.items.find((e) => e.accion === 'crear');
    const anular = result.items.find((e) => e.accion === 'anular');

    expect(crear).toMatchObject({
      usuarioId: creadorId.toString(),
      usuarioNombre: 'Creador',
      fecha: '2026-08-05T15:30:00.000Z',
    });
    expect(anular).toMatchObject({
      usuarioId: anuladorId.toString(),
      usuarioNombre: 'Anulador',
      fecha: '2026-08-10T09:00:00.000Z',
    });
  });

  it('filters by usuarioId', async () => {
    const userA = id();
    const userB = id();
    const r1 = reciboDoc({ generatedBy: userA, fullNumber: 'RC-A' });
    const r2 = reciboDoc({ generatedBy: userB, fullNumber: 'RC-B' });

    const svc = servicio({
      recibos: find([r1, r2]),
      accounts: find([accountDoc({ _id: userA }), accountDoc({ _id: userB })]),
    });

    const result = await svc.findAll({ usuarioId: userA.toString() });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].numeroCompleto).toBe('RC-A');
    // The usuarios dropdown list stays the FULL set, independent of the filter.
    expect(result.usuarios).toHaveLength(2);
  });

  it('filters by tipoDocumento', async () => {
    const r = reciboDoc();
    const nc = notaCreditoDoc();

    const svc = servicio({
      recibos: find([r]),
      notasCredito: find([nc]),
    });

    const result = await svc.findAll({ tipoDocumento: 'Recibo' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].tipoDocumento).toBe('Recibo');
  });

  it('filters by numero (partial, case-insensitive match)', async () => {
    const r1 = reciboDoc({ fullNumber: 'RC-2026-001' });
    const r2 = reciboDoc({ fullNumber: 'RC-2026-002' });

    const svc = servicio({ recibos: find([r1, r2]) });

    const result = await svc.findAll({ numero: '001' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].numeroCompleto).toBe('RC-2026-001');
  });

  it('filters by desde/hasta, inclusive on the event fecha', async () => {
    const rDentro = reciboDoc({
      fullNumber: 'RC-DENTRO',
      createdAt: new Date('2026-08-15T00:00:00.000Z'),
    });
    const rFuera = reciboDoc({
      fullNumber: 'RC-FUERA',
      createdAt: new Date('2026-09-15T00:00:00.000Z'),
    });

    const svc = servicio({ recibos: find([rDentro, rFuera]) });

    const result = await svc.findAll({
      desde: '2026-08-01',
      hasta: '2026-08-31',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].numeroCompleto).toBe('RC-DENTRO');
  });

  it('combines usuarioId, tipoDocumento and desde/hasta filters', async () => {
    const usuario = id();
    const rMatch = reciboDoc({
      generatedBy: usuario,
      fullNumber: 'RC-MATCH',
      createdAt: new Date('2026-08-15T00:00:00.000Z'),
    });
    const rOtroUsuario = reciboDoc({
      fullNumber: 'RC-OTRO',
      createdAt: new Date('2026-08-15T00:00:00.000Z'),
    });
    const ncMismoUsuario = notaCreditoDoc({
      generatedBy: usuario,
      createdAt: new Date('2026-08-15T00:00:00.000Z'),
    });

    const svc = servicio({
      recibos: find([rMatch, rOtroUsuario]),
      notasCredito: find([ncMismoUsuario]),
    });

    const result = await svc.findAll({
      usuarioId: usuario.toString(),
      tipoDocumento: 'Recibo',
      desde: '2026-08-01',
      hasta: '2026-08-31',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].numeroCompleto).toBe('RC-MATCH');
  });

  it('paginates, sorted by fecha descending', async () => {
    const recibos = [1, 2, 3, 4, 5].map((n) =>
      reciboDoc({
        fullNumber: `RC-00${n}`,
        createdAt: new Date(`2026-08-0${n}T00:00:00.000Z`),
      }),
    );

    const svc = servicio({ recibos: find(recibos) });

    const result = await svc.findAll({ pagina: 2, porPagina: 2 });

    expect(result.total).toBe(5);
    expect(result.pagina).toBe(2);
    expect(result.porPagina).toBe(2);
    // Newest first: RC-005, RC-004, RC-003, RC-002, RC-001 — page 2 is
    // RC-003, RC-002.
    expect(result.items.map((e) => e.numeroCompleto)).toEqual([
      'RC-003',
      'RC-002',
    ]);
  });

  it('builds the usuarios distinct-actor list from every actor across all 6 types', async () => {
    const userA = id();
    const userB = id();
    const r = reciboDoc({ generatedBy: userA });
    const nc = notaCreditoDoc({ generatedBy: userB });

    const svc = servicio({
      recibos: find([r]),
      notasCredito: find([nc]),
      accounts: find([
        accountDoc({ _id: userA, fullName: 'Beto' }),
        accountDoc({ _id: userB, fullName: 'Ana' }),
      ]),
    });

    const result = await svc.findAll({});

    // Sorted alphabetically by nombre.
    expect(result.usuarios).toEqual([
      { accountId: userB.toString(), nombre: 'Ana' },
      { accountId: userA.toString(), nombre: 'Beto' },
    ]);
  });
});

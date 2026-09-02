import { Types } from 'mongoose';
import { calcularDocumentosConSaldoAFecha } from './cartera-historica.util';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const facturaDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  issueDate: new Date('2026-01-01'),
  dueDate: new Date('2026-02-01'),
  total: 100000,
  outstandingBalance: 100000,
  status: 'emitida',
  lines: [],
  ...over,
});

const ndDoc = (over: Record<string, unknown> = {}) => ({
  _id: id(),
  coPropertyId: COP,
  inmuebleId: id(),
  issueDate: new Date('2026-01-15'),
  total: 50000,
  outstandingBalance: 50000,
  status: 'emitida',
  ...over,
});

const appDoc = (
  documentId: Types.ObjectId,
  over: Record<string, unknown> = {},
) => ({
  _id: id(),
  coPropertyId: COP,
  documentId,
  amountApplied: 0,
  status: 'activa',
  appliedAt: new Date('2026-01-20'),
  revertedAt: null,
  ...over,
});

/** Mock that respects inmuebleId filter for facturas */
const mockModels = (
  facturas: unknown[] = [],
  notasDebito: unknown[] = [],
  aplicaciones: unknown[] = [],
) => ({
  facturas: {
    find: jest.fn().mockImplementation((filter: Record<string, unknown>) => {
      let data = facturas;
      if (filter.inmuebleId) {
        data = data.filter(
          (f: Record<string, unknown>) =>
            (f.inmuebleId as Types.ObjectId).toString() ===
            (filter.inmuebleId as Types.ObjectId).toString(),
        );
      }
      return { exec: jest.fn().mockResolvedValue(data) };
    }),
  },
  notasDebito: {
    find: jest.fn().mockImplementation((filter: Record<string, unknown>) => {
      let data = notasDebito;
      if (filter.inmuebleId) {
        data = data.filter(
          (nd: Record<string, unknown>) =>
            (nd.inmuebleId as Types.ObjectId).toString() ===
            (filter.inmuebleId as Types.ObjectId).toString(),
        );
      }
      return { exec: jest.fn().mockResolvedValue(data) };
    }),
  },
  aplicaciones: {
    find: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(aplicaciones),
    }),
  },
});

describe('calcularDocumentosConSaldoAFecha', () => {
  it('una Factura sin aplicaciones: montoPendiente === total', async () => {
    const f = facturaDoc({ total: 100000 });
    const models = mockModels([f]);

    const result = await calcularDocumentosConSaldoAFecha(
      models as never,
      COP,
      new Date('2026-06-01'),
    );

    expect(result).toHaveLength(1);
    expect(result[0].montoPendiente).toBe(100000);
  });

  it('una aplicacion activa antes de fecha reduce montoPendiente', async () => {
    const fId = id();
    const f = facturaDoc({ _id: fId, total: 100000 });
    const app = appDoc(fId, {
      amountApplied: 30000,
      appliedAt: new Date('2026-02-01'),
    });
    const models = mockModels([f], [], [app]);

    const result = await calcularDocumentosConSaldoAFecha(
      models as never,
      COP,
      new Date('2026-06-01'),
    );

    expect(result[0].montoPendiente).toBe(70000);
  });

  it('una aplicacion revertida DESPUES de fecha AUN reduce montoPendiente', async () => {
    const fId = id();
    const f = facturaDoc({ _id: fId, total: 100000 });
    const app = appDoc(fId, {
      amountApplied: 40000,
      appliedAt: new Date('2026-01-20'),
      status: 'revertida',
      revertedAt: new Date('2026-03-01'),
    });
    const models = mockModels([f], [], [app]);

    const result = await calcularDocumentosConSaldoAFecha(
      models as never,
      COP,
      new Date('2026-02-15'),
    );

    expect(result[0].montoPendiente).toBe(60000);
  });

  it('una aplicacion revertida ANTES de fecha NO reduce montoPendiente', async () => {
    const fId = id();
    const f = facturaDoc({ _id: fId, total: 100000 });
    const app = appDoc(fId, {
      amountApplied: 40000,
      appliedAt: new Date('2026-01-20'),
      status: 'revertida',
      revertedAt: new Date('2026-01-25'),
    });
    const models = mockModels([f], [], [app]);

    const result = await calcularDocumentosConSaldoAFecha(
      models as never,
      COP,
      new Date('2026-02-15'),
    );

    expect(result[0].montoPendiente).toBe(100000);
  });

  it('un documento con montoPendiente exactamente 0 se excluye', async () => {
    const fId = id();
    const f = facturaDoc({ _id: fId, total: 100000 });
    const app = appDoc(fId, { amountApplied: 100000 });
    const models = mockModels([f], [], [app]);

    const result = await calcularDocumentosConSaldoAFecha(
      models as never,
      COP,
      new Date('2026-06-01'),
    );

    expect(result).toHaveLength(0);
  });

  it('opciones.inmuebleId restringe resultados a ese inmueble', async () => {
    const inmA = id();
    const inmB = id();
    const fA = facturaDoc({ inmuebleId: inmA, total: 100000 });
    const fB = facturaDoc({ inmuebleId: inmB, total: 200000 });
    const models = mockModels([fA, fB]);

    const result = await calcularDocumentosConSaldoAFecha(
      models as never,
      COP,
      new Date('2026-06-01'),
      { inmuebleId: inmA },
    );

    expect(result).toHaveLength(1);
    expect(result[0].inmuebleId).toBe(inmA);
    expect(result[0].montoPendiente).toBe(100000);
  });

  it('opciones.conceptoId: NotaDebito coincide por campo directo', async () => {
    const conceptoId = id();
    const nd = ndDoc({ conceptoId, total: 50000 });
    const models = mockModels([], [nd]);

    const result = await calcularDocumentosConSaldoAFecha(
      models as never,
      COP,
      new Date('2026-06-01'),
      { conceptoId },
    );

    expect(result).toHaveLength(1);
    expect(result[0].tipo).toBe('ND');
  });

  it('opciones.conceptoId: Factura coincide si alguna linea tiene ese conceptoId', async () => {
    const conceptoId = id();
    const f = facturaDoc({
      total: 100000,
      lines: [{ conceptoId }, { conceptoId: id() }],
    });
    const models = mockModels([f]);

    const result = await calcularDocumentosConSaldoAFecha(
      models as never,
      COP,
      new Date('2026-06-01'),
      { conceptoId },
    );

    expect(result).toHaveLength(1);
    expect(result[0].tipo).toBe('FV');
  });
});

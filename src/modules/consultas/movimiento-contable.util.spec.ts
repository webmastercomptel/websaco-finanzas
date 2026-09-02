import { Types } from 'mongoose';
import {
  deriveTipoDocumento,
  resolveAnchorId,
  resolverMovimientoContable,
} from './movimiento-contable.util';
import type { AsientoContableDocument } from '../../database/schemas/facturacion/asiento-contable.schema';

const id = () => new Types.ObjectId();

const asientoBase = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: id(),
    date: new Date('2026-08-15'),
    entries: [
      {
        account: '1355-01',
        type: 'debito',
        amount: 100000,
        description: 'Administración agosto',
      },
      {
        account: '4135-01',
        type: 'credito',
        amount: 100000,
        description: 'Ingresos por administración',
      },
    ],
    facturaId: null,
    reciboId: null,
    notaCreditoId: null,
    notaDebitoId: null,
    notaContableId: null,
    ...overrides,
  }) as unknown as AsientoContableDocument;

describe('deriveTipoDocumento', () => {
  it('returns FC when facturaId is set', () => {
    const a = asientoBase({ facturaId: id() });
    expect(deriveTipoDocumento(a)).toBe('FC');
  });

  it('returns RC when reciboId is set', () => {
    const a = asientoBase({ reciboId: id() });
    expect(deriveTipoDocumento(a)).toBe('RC');
  });

  it('returns NC when notaCreditoId is set', () => {
    const a = asientoBase({ notaCreditoId: id() });
    expect(deriveTipoDocumento(a)).toBe('NC');
  });

  it('returns ND when notaDebitoId is set', () => {
    const a = asientoBase({ notaDebitoId: id() });
    expect(deriveTipoDocumento(a)).toBe('ND');
  });

  it('returns NT when notaContableId is set', () => {
    const a = asientoBase({ notaContableId: id() });
    expect(deriveTipoDocumento(a)).toBe('NT');
  });
});

describe('resolveAnchorId', () => {
  it('returns facturaId when set', () => {
    const anchorId = id();
    const a = asientoBase({ facturaId: anchorId });
    expect(resolveAnchorId(a)).toBe(anchorId);
  });

  it('returns reciboId when set', () => {
    const anchorId = id();
    const a = asientoBase({ reciboId: anchorId });
    expect(resolveAnchorId(a)).toBe(anchorId);
  });

  it('throws when no anchor is set', () => {
    const a = asientoBase();
    expect(() => resolveAnchorId(a)).toThrow(
      'AsientoContable has no anchor document',
    );
  });
});

describe('resolverMovimientoContable', () => {
  it('produces a correct MovimientoContable from a balanced asiento', () => {
    const asiento = asientoBase({
      facturaId: id(),
      entries: [
        {
          account: '1355-01',
          type: 'debito',
          amount: 200000,
          description: 'Línea 1',
        },
        {
          account: '4135-01',
          type: 'credito',
          amount: 150000,
          description: 'Línea 2',
        },
        {
          account: '4135-02',
          type: 'credito',
          amount: 50000,
          description: 'Línea 3',
        },
      ],
    });

    const result = resolverMovimientoContable(asiento, {
      inmuebleCodigo: '301',
      propietario: 'Juan Perez',
      nit: '900123456-7',
      numeroDocumento: 'FV-0001',
    });

    expect(result.tipoDocumento).toBe('FC');
    expect(result.numeroDocumento).toBe('FV-0001');
    expect(result.inmuebleCodigo).toBe('301');
    expect(result.propietario).toBe('Juan Perez');
    expect(result.nit).toBe('900123456-7');
    expect(result.lineas).toHaveLength(3);
    expect(result.totalDebito).toBe(200000);
    expect(result.totalCredito).toBe(200000);
    expect(result.cuadra).toBe(true);
  });

  it('cuadra is false when totals do not match', () => {
    const asiento = asientoBase({
      reciboId: id(),
      entries: [
        {
          account: '1105-01',
          type: 'debito',
          amount: 100000,
          description: 'Efectivo',
        },
        {
          account: '1355-01',
          type: 'credito',
          amount: 80000,
          description: 'Parcial',
        },
      ],
    });

    const result = resolverMovimientoContable(asiento, {
      inmuebleCodigo: null,
      propietario: null,
      nit: null,
      numeroDocumento: 'RC-0001',
    });

    expect(result.totalDebito).toBe(100000);
    expect(result.totalCredito).toBe(80000);
    expect(result.cuadra).toBe(false);
  });

  it('propietario and nit are null when Inmueble has no holder', () => {
    const asiento = asientoBase({ notaDebitoId: id() });

    const result = resolverMovimientoContable(asiento, {
      inmuebleCodigo: '101',
      propietario: null,
      nit: null,
      numeroDocumento: 'ND-0001',
    });

    expect(result.propietario).toBeNull();
    expect(result.nit).toBeNull();
    expect(result.inmuebleCodigo).toBe('101');
  });

  it('documentoId equals the anchor document _id, not the asiento _id', () => {
    const anchorId = id();
    const asientoId = id();
    const asiento = asientoBase({
      _id: asientoId,
      notaContableId: anchorId,
    });

    const result = resolverMovimientoContable(asiento, {
      inmuebleCodigo: null,
      propietario: null,
      nit: null,
      numeroDocumento: 'NT-0001',
    });

    expect(result.documentoId).toBe(anchorId.toString());
    expect(result.id).toBe(asientoId.toString());
  });

  it('inmuebleCodigo is null when inmueble was deleted', () => {
    const asiento = asientoBase({ facturaId: id() });

    const result = resolverMovimientoContable(asiento, {
      inmuebleCodigo: null,
      propietario: 'Test',
      nit: null,
      numeroDocumento: 'FV-0002',
    });

    expect(result.inmuebleCodigo).toBeNull();
  });
});

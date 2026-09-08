import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { ConsultaFacturacionService } from './consulta-facturacion.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();

const lote = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'lote-1' },
  coPropertyId: COP,
  number: 12,
  status: 'consolidado',
  billingDate: new Date('2026-08-06'),
  dueDate: new Date('2026-08-31'),
  ...over,
});

const linea = (over: Record<string, unknown> = {}) => ({
  conceptoId: { toString: () => 'con-admin' },
  conceptName: 'Administración',
  conceptKind: 'administracion',
  source: 'recurrente',
  baseAmount: 100000,
  taxRate: 0,
  taxAmount: 0,
  totalAmount: 100000,
  ...over,
});

const factura = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'fac-1' },
  coPropertyId: COP,
  loteId: 'lote-1',
  inmuebleId: { toString: () => 'inm-1' },
  unitCode: '301',
  prefix: 'CONJ-2026',
  number: 1041,
  fullNumber: 'CONJ-2026-1041',
  issueDate: new Date('2026-08-06'),
  dueDate: new Date('2026-08-31'),
  lines: [linea()],
  subtotal: 100000,
  totalTax: 0,
  total: 100000,
  status: 'emitida',
  ...over,
});

const concepto = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'con-admin' },
  name: 'Administración',
  sortOrder: 1,
  ...over,
});

type Filtro = Record<string, unknown>;

const loteModeloCon = (filas: unknown[]) => ({
  findOne: jest.fn(() => ({ exec: () => Promise.resolve(filas[0] ?? null) })),
});

const facturasModeloCon = (filas: unknown[]) => {
  const filtros: Filtro[] = [];
  return {
    filtros,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return { sort: () => ({ exec: () => Promise.resolve(filas) }) };
    }),
  };
};

const conceptosModeloCon = (filas: unknown[]) => ({
  find: jest.fn(() => ({ exec: () => Promise.resolve(filas) })),
});

const tenantQueDevuelve = (id: Types.ObjectId | null): TenantContextService =>
  ({
    resolveCoPropertyId: () => {
      if (id === null) throw new ForbiddenException('sin copropiedad activa');
      return id;
    },
  }) as unknown as TenantContextService;

const makeService = (opts: {
  lote?: unknown[];
  facturas?: unknown[];
  conceptos?: unknown[];
}) =>
  new ConsultaFacturacionService(
    facturasModeloCon(opts.facturas ?? []) as never,
    loteModeloCon(opts.lote ?? [lote()]) as never,
    conceptosModeloCon(opts.conceptos ?? [concepto()]) as never,
    tenantQueDevuelve(COP),
  );

describe('ConsultaFacturacionService.generar', () => {
  it('lanza NotFoundException si el lote no existe o es de otra copropiedad', async () => {
    const service = makeService({ lote: [] });
    await expect(service.generar('lote-ajeno')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lanza ConflictException si el lote no está consolidado', async () => {
    const service = makeService({ lote: [lote({ status: 'liquidado' })] });
    await expect(service.generar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('excluye facturas anuladas de los totales y las filas', async () => {
    const service = makeService({
      facturas: [factura({ status: 'emitida' })],
    });
    const resultado = await service.generar('lote-1');

    expect(resultado.filas).toHaveLength(1);
    expect(resultado.total).toBe(100000);
  });

  it('suma un concepto que aparece en más de una línea de la misma factura', async () => {
    const service = makeService({
      facturas: [
        factura({
          lines: [linea({ baseAmount: 60000 }), linea({ baseAmount: 40000 })],
          subtotal: 100000,
        }),
      ],
    });
    const resultado = await service.generar('lote-1');

    expect(resultado.filas[0].valoresPorConcepto['con-admin']).toBe(100000);
    expect(resultado.totalesPorConcepto[0].monto).toBe(100000);
  });

  it('ordena los conceptos por sortOrder y luego por nombre', async () => {
    const service = makeService({
      facturas: [
        factura({
          lines: [
            linea({
              conceptoId: { toString: () => 'con-intereses' },
              conceptName: 'Intereses',
              baseAmount: 5000,
            }),
            linea({
              conceptoId: { toString: () => 'con-admin' },
              conceptName: 'Administración',
              baseAmount: 100000,
            }),
          ],
        }),
      ],
      conceptos: [
        concepto({ _id: { toString: () => 'con-admin' }, sortOrder: 1 }),
        concepto({
          _id: { toString: () => 'con-intereses' },
          name: 'Intereses',
          sortOrder: 2,
        }),
      ],
    });
    const resultado = await service.generar('lote-1');

    expect(resultado.totalesPorConcepto.map((c) => c.nombreConcepto)).toEqual([
      'Administración',
      'Intereses',
    ]);
  });

  it('un lote consolidado sin facturas devuelve arrays vacíos sin lanzar', async () => {
    const service = makeService({ facturas: [] });
    const resultado = await service.generar('lote-1');

    expect(resultado.filas).toEqual([]);
    expect(resultado.totalesPorConcepto).toEqual([]);
    expect(resultado.total).toBe(0);
  });
});

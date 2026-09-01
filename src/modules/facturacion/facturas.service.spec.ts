import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { FacturasService } from './facturas.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const documento = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'fac-1' },
  coPropertyId: COP,
  loteId: { toString: () => 'lote-1' },
  inmuebleId: { toString: () => 'inm-1' },
  unitCode: '301',
  terceroId: { toString: () => 'ter-1' },
  holder: { name: 'Ana Pérez', identificationNumber: '123456' },
  prefix: 'CONJ-2026',
  number: 1041,
  fullNumber: 'CONJ-2026-1041',
  issueDate: new Date('2026-08-27'),
  dueDate: new Date('2026-08-31'),
  periodStart: new Date('2026-08-01'),
  periodEnd: new Date('2026-08-31'),
  lines: [
    {
      conceptoId: { toString: () => 'con-1' },
      conceptName: 'Administración',
      conceptKind: 'administracion',
      accountingIncomeAccount: '413501',
      source: 'recurrente',
      baseAmount: 520000,
      taxRate: 0,
      taxAmount: 0,
      totalAmount: 520000,
    },
  ],
  subtotal: 520000,
  totalTax: 0,
  total: 520000,
  outstandingBalance: 520000,
  status: 'emitida',
  voidedByCreditNoteId: null,
  ...over,
});

const modeloCon = (filas: unknown[], total = filas.length) => {
  const filtros: Filtro[] = [];
  const cadena = {
    sort: () => cadena,
    skip: () => cadena,
    limit: () => cadena,
    exec: () => Promise.resolve(filas),
  };
  return {
    filtros,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return cadena;
    }),
    findOne: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return { exec: () => Promise.resolve(filas[0] ?? null) };
    }),
    countDocuments: jest.fn(() => ({ exec: () => Promise.resolve(total) })),
  };
};

const tenantQueDevuelve = (id: Types.ObjectId | null): TenantContextService =>
  ({
    resolveCoPropertyId: () => {
      if (id === null) throw new ForbiddenException('sin copropiedad activa');
      return id;
    },
  }) as unknown as TenantContextService;

describe('FacturasService.findAll', () => {
  it('filtra SIEMPRE por la copropiedad activa', async () => {
    const modelo = modeloCon([documento()]);
    const service = new FacturasService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.findAll({});

    expect(modelo.filtros[0].coPropertyId).toBe(COP);
  });

  it('devuelve el contrato en español, con el titular congelado', async () => {
    const modelo = modeloCon([documento()]);
    const service = new FacturasService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    const { items } = await service.findAll({});

    expect(items[0]).toMatchObject({
      numeroCompleto: 'CONJ-2026-1041',
      total: 520000,
      titular: { nombre: 'Ana Pérez', numeroIdentificacion: '123456' },
      lineas: [expect.objectContaining({ nombreConcepto: 'Administración' })],
    });
  });
});

describe('FacturasService.findOne', () => {
  it('busca por id Y copropiedad en la misma consulta', async () => {
    const modelo = modeloCon([documento()]);
    const service = new FacturasService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.findOne('fac-1');

    expect(modelo.filtros[0]).toEqual({ _id: 'fac-1', coPropertyId: COP });
  });

  it('responde "no existe" para una factura de otra copropiedad', async () => {
    const modelo = modeloCon([]);
    const service = new FacturasService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await expect(service.findOne('fac-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('FacturasService.findAll — conSaldoPendiente', () => {
  it('filtra por outstandingBalance > 0 cuando conSaldoPendiente es true', async () => {
    const modelo = modeloCon([documento()]);
    const service = new FacturasService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.findAll({ conSaldoPendiente: true });

    expect(modelo.filtros[0]).toMatchObject({
      outstandingBalance: { $gt: 0 },
      status: 'emitida',
    });
  });

  it('no aplica el filtro cuando conSaldoPendiente es false o ausente', async () => {
    const modelo = modeloCon([documento()]);
    const service = new FacturasService(
      modelo as never,
      tenantQueDevuelve(COP),
    );

    await service.findAll({});

    expect(modelo.filtros[0].outstandingBalance).toBeUndefined();
    expect(modelo.filtros[0].status).toBeUndefined();
  });
});

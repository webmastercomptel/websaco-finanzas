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
  copropiedadId: COP,
  numero: 12,
  estado: 'consolidado',
  fechaFacturacion: new Date('2026-08-06'),
  fechaVencimiento: new Date('2026-08-31'),
  ...over,
});

const linea = (over: Record<string, unknown> = {}) => ({
  conceptoId: { toString: () => 'con-admin' },
  nombreConcepto: 'Administración',
  tipoConcepto: 'administracion',
  origen: 'recurrente',
  valorBase: 100000,
  tasaImpuesto: 0,
  valorImpuesto: 0,
  valorTotal: 100000,
  ...over,
});

const factura = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'fac-1' },
  copropiedadId: COP,
  loteId: 'lote-1',
  inmuebleId: { toString: () => 'inm-1' },
  codigoInmueble: '301',
  prefijo: 'CONJ-2026',
  numero: 1041,
  numeroCompleto: 'CONJ-2026-1041',
  fechaEmision: new Date('2026-08-06'),
  fechaVencimiento: new Date('2026-08-31'),
  lineas: [linea()],
  subtotal: 100000,
  totalImpuestos: 0,
  total: 100000,
  estado: 'emitida',
  ...over,
});

const concepto = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'con-admin' },
  nombre: 'Administración',
  orden: 1,
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

const saldoTotalDocumentoModeloCon = (filas: unknown[]) => ({
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
  saldos?: unknown[];
}) =>
  new ConsultaFacturacionService(
    facturasModeloCon(opts.facturas ?? []) as never,
    loteModeloCon(opts.lote ?? [lote()]) as never,
    conceptosModeloCon(opts.conceptos ?? [concepto()]) as never,
    saldoTotalDocumentoModeloCon(opts.saldos ?? []) as never,
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
    const service = makeService({ lote: [lote({ estado: 'liquidado' })] });
    await expect(service.generar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('excluye facturas anuladas de los totales y las filas', async () => {
    const service = makeService({
      facturas: [factura({ estado: 'emitida' })],
    });
    const resultado = await service.generar('lote-1');

    expect(resultado.filas).toHaveLength(1);
    expect(resultado.total).toBe(100000);
  });

  it('suma un concepto que aparece en más de una línea de la misma factura', async () => {
    const service = makeService({
      facturas: [
        factura({
          lineas: [linea({ valorBase: 60000 }), linea({ valorBase: 40000 })],
          subtotal: 100000,
        }),
      ],
    });
    const resultado = await service.generar('lote-1');

    expect(resultado.filas[0].valoresPorConcepto['con-admin']).toBe(100000);
    expect(resultado.totalesPorConcepto[0].monto).toBe(100000);
  });

  it('ordena los conceptos por orden y luego por nombre', async () => {
    const service = makeService({
      facturas: [
        factura({
          lineas: [
            linea({
              conceptoId: { toString: () => 'con-intereses' },
              nombreConcepto: 'Intereses',
              valorBase: 5000,
            }),
            linea({
              conceptoId: { toString: () => 'con-admin' },
              nombreConcepto: 'Administración',
              valorBase: 100000,
            }),
          ],
        }),
      ],
      conceptos: [
        concepto({ _id: { toString: () => 'con-admin' }, orden: 1 }),
        concepto({
          _id: { toString: () => 'con-intereses' },
          nombre: 'Intereses',
          orden: 2,
        }),
      ],
    });
    const resultado = await service.generar('lote-1');

    expect(resultado.totalesPorConcepto.map((c) => c.nombreConcepto)).toEqual([
      'Administración',
      'Intereses',
    ]);
  });

  it('desglosa el IVA por concepto, para que fila y totales cuadren con el total facturado', async () => {
    const service = makeService({
      facturas: [
        factura({
          lineas: [
            linea({ valorBase: 100000, tasaImpuesto: 0, valorImpuesto: 0 }),
            linea({
              conceptoId: { toString: () => 'con-multas' },
              nombreConcepto: 'Multas',
              valorBase: 50000,
              tasaImpuesto: 10,
              valorImpuesto: 5000,
              valorTotal: 55000,
            }),
          ],
          subtotal: 150000,
          totalImpuestos: 5000,
          total: 155000,
        }),
      ],
      conceptos: [
        concepto(),
        concepto({
          _id: { toString: () => 'con-multas' },
          nombre: 'Multas',
          orden: 2,
        }),
      ],
    });
    const resultado = await service.generar('lote-1');

    expect(resultado.filas[0].valoresIvaPorConcepto).toEqual({
      'con-multas': 5000,
    });
    const [admin, multas] = resultado.totalesPorConcepto;
    expect(admin).toMatchObject({ conceptoId: 'con-admin', montoIva: 0 });
    expect(multas).toMatchObject({ conceptoId: 'con-multas', montoIva: 5000 });

    // La fila cuadra: base(s) + iva(s) == total facturado.
    const fila = resultado.filas[0];
    const sumaBase = Object.values(fila.valoresPorConcepto).reduce(
      (a, b) => a + b,
      0,
    );
    const sumaIva = Object.values(fila.valoresIvaPorConcepto).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sumaBase + sumaIva).toBe(fila.total);
  });

  it('resuelve id, titular, saldoPendiente y estado por fila — mismas columnas que Facturas', async () => {
    const service = makeService({
      facturas: [factura({ titular: { nombre: 'Juan Pérez' } })],
      saldos: [
        { documentoId: { toString: () => 'fac-1' }, saldoPendiente: 40000 },
      ],
    });
    const resultado = await service.generar('lote-1');

    expect(resultado.filas[0]).toMatchObject({
      id: 'fac-1',
      titular: { nombre: 'Juan Pérez' },
      saldoPendiente: 40000,
      estado: 'emitida',
    });
  });

  it('un lote consolidado sin facturas devuelve arrays vacíos sin lanzar', async () => {
    const service = makeService({ facturas: [] });
    const resultado = await service.generar('lote-1');

    expect(resultado.filas).toEqual([]);
    expect(resultado.totalesPorConcepto).toEqual([]);
    expect(resultado.total).toBe(0);
  });
});

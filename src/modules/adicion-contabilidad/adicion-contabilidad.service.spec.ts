import { Types } from 'mongoose';
import { AdicionContabilidadService } from './adicion-contabilidad.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { LotesFacturacionService } from '../facturacion/lotes.service';

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId().toString();

const reciboIdRC = new Types.ObjectId();
const reciboIdOrigenNA = new Types.ObjectId();
const notaCreditoId = new Types.ObjectId();
const notaDebitoId = new Types.ObjectId();
const notaContableId = new Types.ObjectId();
const notaAnticipoId = new Types.ObjectId();
const facturaId = new Types.ObjectId();

/** Every model this service injects is only ever chained as
 *  `.find(filtro, proyeccion).session(session).exec()` — same shape
 *  `buildAnchorMap`/`resolveConceptos`/`resolveComprobantes` all use, so one
 *  fake covers every one of them regardless of which projection was asked
 *  for (the fixture docs below always carry every field either call needs). */
const modeloCon = (docs: Record<string, unknown>[]) => ({
  find: jest.fn(() => ({
    session: () => ({ exec: () => Promise.resolve(docs) }),
  })),
});

const movimientosFijos = [
  { cuenta: '1305', tipo: 'debito' as const, monto: 100, descripcion: 'x' },
  { cuenta: '4135', tipo: 'credito' as const, monto: 100, descripcion: 'y' },
];

const asientoFixture = (over: Record<string, unknown>) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  loteId: null,
  facturaId: null,
  reciboId: null,
  notaCreditoId: null,
  notaDebitoId: null,
  notaContableId: null,
  notaAnticipoId: null,
  fecha: new Date('2026-09-05'),
  movimientos: movimientosFijos,
  contabilidadLoteId: null,
  ...over,
});

describe('AdicionContabilidadService.generar', () => {
  it('usa el concepto propio de cada documento como detalle, no el texto fijo del asiento', async () => {
    const asientos = [
      asientoFixture({ reciboId: reciboIdRC }),
      asientoFixture({ notaCreditoId }),
      asientoFixture({ notaDebitoId }),
      asientoFixture({ notaContableId }),
      asientoFixture({ notaAnticipoId }),
      asientoFixture({
        facturaId,
        movimientos: [
          {
            cuenta: '4135',
            tipo: 'credito' as const,
            monto: 100,
            descripcion: 'Administración',
          },
          {
            cuenta: '1305',
            tipo: 'debito' as const,
            monto: 100,
            descripcion: 'Cartera por cobrar — factura de venta',
          },
        ],
      }),
    ];

    const asientosModel = {
      find: jest.fn(() => ({
        sort: () => ({
          session: () => ({ exec: () => Promise.resolve(asientos) }),
        }),
      })),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    const lotesModel = {
      create: jest.fn((docs: Record<string, unknown>[]) =>
        Promise.resolve(
          docs.map((d) => ({
            ...d,
            _id: new Types.ObjectId(),
            createdAt: new Date('2026-09-10'),
          })),
        ),
      ),
    };
    const consecutivosLoteModel = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve({ nextNumber: 1 }),
      })),
    };
    const consecutivosDocumentoModel = modeloCon([]);
    const facturasModel = modeloCon([
      {
        _id: facturaId,
        prefijo: 'FV',
        numero: 60,
        periodoDesde: new Date('2026-09-01'),
        periodoHasta: new Date('2026-09-30'),
      },
    ]);
    const recibosModel = modeloCon([
      {
        _id: reciboIdRC,
        prefijo: 'RC',
        numero: 10,
        observaciones: 'Pago cuota administración enero',
      },
      { _id: reciboIdOrigenNA, prefijo: 'RC', numero: 55, observaciones: null },
    ]);
    const notasCreditoModel = modeloCon([
      {
        _id: notaCreditoId,
        prefijo: 'NC',
        numero: 20,
        observaciones: 'Corrección error de digitación',
      },
    ]);
    const notasDebitoModel = modeloCon([
      {
        _id: notaDebitoId,
        prefijo: 'ND',
        numero: 30,
        descripcion: 'Cobro por daño en zona común',
      },
    ]);
    const notasContablesModel = modeloCon([
      {
        _id: notaContableId,
        prefijo: 'NT',
        numero: 40,
        descripcion: 'Reclasificación de Administración a Intereses',
      },
    ]);
    const notasAnticipoModel = modeloCon([
      {
        _id: notaAnticipoId,
        prefijo: 'NA',
        numero: 50,
        reciboOrigenId: reciboIdOrigenNA,
      },
    ]);

    const tenant: TenantContextService = {
      resolveCoPropertyId: () => COP,
    } as unknown as TenantContextService;
    const lotesFacturacion: LotesFacturacionService = {
      obtenerUltimoConsolidado: jest.fn().mockResolvedValue({
        periodoDesde: new Date('2026-09-01'),
        periodoHasta: new Date('2026-09-30'),
      }),
    } as unknown as LotesFacturacionService;
    const connection = {
      startSession: () =>
        Promise.resolve({
          withTransaction: (fn: () => Promise<void>) => fn(),
          endSession: () => Promise.resolve(undefined),
        }),
    };

    const service = new AdicionContabilidadService(
      asientosModel as never,
      lotesModel as never,
      consecutivosLoteModel as never,
      consecutivosDocumentoModel as never,
      facturasModel as never,
      recibosModel as never,
      notasCreditoModel as never,
      notasDebitoModel as never,
      notasContablesModel as never,
      notasAnticipoModel as never,
      tenant,
      lotesFacturacion,
      connection as never,
    );

    const resultado = await service.generar(CUENTA);

    // RC/NC/ND/NT: el propio concepto del documento, no el texto fijo del asiento.
    expect(resultado.movmes).toContain('Pago cuota administración enero');
    expect(resultado.movmes).toContain('Corrección error de digitación');
    expect(resultado.movmes).toContain('Cobro por daño en zona común');
    expect(resultado.movmes).toContain(
      'Reclasificación de Administración a Intereses',
    );
    // NA: compuesto desde el recibo origen, no desde detalleConceptos.
    expect(resultado.movmes).toContain('Aplicación de Anticipo RC # 55');
    // FV: el período facturado, igual para las dos líneas de la factura.
    expect(resultado.movmes).toContain(
      'Cargo del Periodo 01/09/2026 - 30/09/2026',
    );

    // MOVMESDO: cada línea del mismo asiento lleva el MISMO detalle que el
    // header — ya no el texto por línea débito/crédito de `movimientos[]`.
    const lineasMovmesdo = resultado.movmesdo
      .split('\r\n')
      .filter((l) => l.length > 0);
    expect(lineasMovmesdo).toHaveLength(12); // 6 asientos x 2 líneas cada uno
    const lineasFactura = lineasMovmesdo.filter((l) =>
      l.includes('Cargo del Periodo 01/09/2026 - 30/09/2026'),
    );
    expect(lineasFactura).toHaveLength(2);
    expect(lineasFactura.some((l) => l.includes('Administración'))).toBe(false);
  });

  it('recurre al texto del asiento cuando el documento no tiene concepto propio', async () => {
    const asiento = asientoFixture({
      reciboId: reciboIdRC,
      movimientos: [
        {
          cuenta: '1305',
          tipo: 'debito' as const,
          monto: 100,
          descripcion: 'Recaudo recibido — recibo de caja',
        },
      ],
    });
    const asientosModel = {
      find: jest.fn(() => ({
        sort: () => ({
          session: () => ({ exec: () => Promise.resolve([asiento]) }),
        }),
      })),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    const lotesModel = {
      create: jest.fn((docs: Record<string, unknown>[]) =>
        Promise.resolve(
          docs.map((d) => ({
            ...d,
            _id: new Types.ObjectId(),
            createdAt: new Date('2026-09-10'),
          })),
        ),
      ),
    };
    const consecutivosLoteModel = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve({ nextNumber: 1 }),
      })),
    };
    const consecutivosDocumentoModel = modeloCon([]);
    const facturasModel = modeloCon([]);
    // observaciones: null — el recibo no trae observaciones.
    const recibosModel = modeloCon([
      { _id: reciboIdRC, prefijo: 'RC', numero: 10, observaciones: null },
    ]);
    const notasCreditoModel = modeloCon([]);
    const notasDebitoModel = modeloCon([]);
    const notasContablesModel = modeloCon([]);
    const notasAnticipoModel = modeloCon([]);

    const tenant: TenantContextService = {
      resolveCoPropertyId: () => COP,
    } as unknown as TenantContextService;
    const lotesFacturacion: LotesFacturacionService = {
      obtenerUltimoConsolidado: jest.fn().mockResolvedValue({
        periodoDesde: new Date('2026-09-01'),
        periodoHasta: new Date('2026-09-30'),
      }),
    } as unknown as LotesFacturacionService;
    const connection = {
      startSession: () =>
        Promise.resolve({
          withTransaction: (fn: () => Promise<void>) => fn(),
          endSession: () => Promise.resolve(undefined),
        }),
    };

    const service = new AdicionContabilidadService(
      asientosModel as never,
      lotesModel as never,
      consecutivosLoteModel as never,
      consecutivosDocumentoModel as never,
      facturasModel as never,
      recibosModel as never,
      notasCreditoModel as never,
      notasDebitoModel as never,
      notasContablesModel as never,
      notasAnticipoModel as never,
      tenant,
      lotesFacturacion,
      connection as never,
    );

    const resultado = await service.generar(CUENTA);

    expect(resultado.movmes).toContain('Recaudo recibido — recibo de caja');
  });
});

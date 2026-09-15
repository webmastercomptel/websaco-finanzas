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

const entriesFijas = [
  { account: '1305', type: 'debito' as const, amount: 100, description: 'x' },
  { account: '4135', type: 'credito' as const, amount: 100, description: 'y' },
];

const asientoFixture = (over: Record<string, unknown>) => ({
  _id: new Types.ObjectId(),
  coPropertyId: COP,
  loteId: null,
  facturaId: null,
  reciboId: null,
  notaCreditoId: null,
  notaDebitoId: null,
  notaContableId: null,
  notaAnticipoId: null,
  date: new Date('2026-09-05'),
  entries: entriesFijas,
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
        entries: [
          {
            account: '4135',
            type: 'credito' as const,
            amount: 100,
            description: 'Administración',
          },
          {
            account: '1305',
            type: 'debito' as const,
            amount: 100,
            description: 'Cartera por cobrar — factura de venta',
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
        prefix: 'FV',
        number: 60,
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
      },
    ]);
    const recibosModel = modeloCon([
      {
        _id: reciboIdRC,
        prefix: 'RC',
        number: 10,
        notes: 'Pago cuota administración enero',
      },
      { _id: reciboIdOrigenNA, prefix: 'RC', number: 55, notes: null },
    ]);
    const notasCreditoModel = modeloCon([
      {
        _id: notaCreditoId,
        prefix: 'NC',
        number: 20,
        notes: 'Corrección error de digitación',
      },
    ]);
    const notasDebitoModel = modeloCon([
      {
        _id: notaDebitoId,
        prefix: 'ND',
        number: 30,
        description: 'Cobro por daño en zona común',
      },
    ]);
    const notasContablesModel = modeloCon([
      {
        _id: notaContableId,
        prefix: 'NT',
        number: 40,
        description: 'Reclasificación de Administración a Intereses',
      },
    ]);
    const notasAnticipoModel = modeloCon([
      {
        _id: notaAnticipoId,
        prefix: 'NA',
        number: 50,
        reciboOrigenId: reciboIdOrigenNA,
      },
    ]);

    const tenant: TenantContextService = {
      resolveCoPropertyId: () => COP,
    } as unknown as TenantContextService;
    const lotesFacturacion: LotesFacturacionService = {
      obtenerUltimoConsolidado: jest.fn().mockResolvedValue({
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
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
    // header — ya no el texto por línea débito/crédito de `entries[]`.
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
      entries: [
        {
          account: '1305',
          type: 'debito' as const,
          amount: 100,
          description: 'Recaudo recibido — recibo de caja',
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
    // notes: null — el recibo no trae observaciones.
    const recibosModel = modeloCon([
      { _id: reciboIdRC, prefix: 'RC', number: 10, notes: null },
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
        periodStart: new Date('2026-09-01'),
        periodEnd: new Date('2026-09-30'),
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

import { Types } from 'mongoose';
import { AdicionContabilidadService } from './adicion-contabilidad.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { LotesFacturacionService } from '../facturacion/lotes.service';

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId().toString();
const ACTOR = { accountId: CUENTA, nombre: 'Contadora Pérez' };

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

    const resultado = await service.generar(ACTOR);

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

    const resultado = await service.generar(ACTOR);

    expect(resultado.movmes).toContain('Recaudo recibido — recibo de caja');
  });
});

describe('AdicionContabilidadService.generar — Nota de Anticipo sobre un Saldo Inicial de Anticipo', () => {
  it('compone el detalle desde el documento original del saldo inicial ("RC # 1234"), no cae al texto fijo', async () => {
    const siaId = new Types.ObjectId();
    const asientos = [asientoFixture({ notaAnticipoId })];
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
    const notasAnticipoModel = modeloCon([
      {
        _id: notaAnticipoId,
        prefijo: 'NA',
        numero: 50,
        origenTipo: 'SI',
        reciboOrigenId: siaId,
      },
    ]);
    const saldosInicialesAnticipoModel = modeloCon([
      { _id: siaId, tipoDocumentoOriginal: 'RC', numeroOriginal: '1234' },
    ]);
    const service = new AdicionContabilidadService(
      asientosModel as never,
      lotesModel as never,
      consecutivosLoteModel as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      notasAnticipoModel as never,
      { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
      {
        obtenerUltimoConsolidado: jest.fn().mockResolvedValue({
          periodoDesde: new Date('2026-09-01'),
          periodoHasta: new Date('2026-09-30'),
        }),
      } as unknown as LotesFacturacionService,
      {
        startSession: () =>
          Promise.resolve({
            withTransaction: (fn: () => Promise<void>) => fn(),
            endSession: () => Promise.resolve(undefined),
          }),
      } as never,
      saldosInicialesAnticipoModel as never,
    );

    const resultado = await service.generar(ACTOR);

    expect(resultado.movmes).toContain('Aplicación de Anticipo RC # 1234');
  });
});

describe('AdicionContabilidadService.generar — documento cruce de Saldo Inicial', () => {
  it('exporta el número ORIGINAL del Saldo Inicial (2941) en "número doc cruce", no el ordinal interno almacenado (2); FV conserva el suyo', async () => {
    const asientos = [
      asientoFixture({
        reciboId: reciboIdRC,
        movimientos: [
          {
            cuenta: '13050501',
            tipo: 'credito' as const,
            monto: 100,
            descripcion: 'x',
            tipoDocumento: 'SI',
            numeroDocumento: 2,
          },
          {
            cuenta: '13050502',
            tipo: 'credito' as const,
            monto: 50,
            descripcion: 'y',
            tipoDocumento: 'FV',
            numeroDocumento: 7,
          },
          {
            cuenta: '11100502',
            tipo: 'debito' as const,
            monto: 150,
            descripcion: 'z',
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
    const recibosModel = modeloCon([
      { _id: reciboIdRC, prefijo: 'RC', numero: 1, observaciones: 'Pago' },
    ]);
    const saldosInicialesModel = modeloCon([
      {
        numero: 2,
        tipoDocumentoOriginal: 'FV',
        numeroOriginal: '2941',
      },
    ]);
    const service = new AdicionContabilidadService(
      asientosModel as never,
      lotesModel as never,
      consecutivosLoteModel as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      recibosModel as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      modeloCon([]) as never,
      { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
      {
        obtenerUltimoConsolidado: jest.fn().mockResolvedValue({
          periodoDesde: new Date('2026-09-01'),
          periodoHasta: new Date('2026-09-30'),
        }),
      } as unknown as LotesFacturacionService,
      {
        startSession: () =>
          Promise.resolve({
            withTransaction: (fn: () => Promise<void>) => fn(),
            endSession: () => Promise.resolve(undefined),
          }),
      } as never,
      undefined,
      saldosInicialesModel as never,
    );

    const resultado = await service.generar(ACTOR);

    const filas = resultado.movmesdo
      .split('\r\n')
      .filter((l) => l !== '')
      .map((l) => l.split(','));
    // column 14 (index 13) = número doc cruce
    expect(filas.map((f) => f[13])).toEqual(['2941', '7', '']);
    expect(saldosInicialesModel.find).toHaveBeenCalledWith(
      { copropiedadId: COP, numero: { $in: [2] } },
      expect.any(Object),
    );
  });
});

describe('AdicionContabilidadService — desmarcar y volver a descargar un lote', () => {
  const LOTE_ID = new Types.ObjectId();

  const loteDoc = (over: Record<string, unknown> = {}) => ({
    _id: LOTE_ID,
    copropiedadId: COP,
    number: 3,
    periodStart: new Date('2026-09-01'),
    periodEnd: new Date('2026-09-30'),
    totalAsientos: 1,
    estado: 'generado',
    fechaDesmarcado: null,
    createdAt: new Date('2026-09-10'),
    ...over,
  });

  const armar = (
    lote: Record<string, unknown> | null,
    conAuditoria = false,
  ) => {
    const asientos = [asientoFixture({ reciboId: reciboIdRC })];
    const asientosModel = {
      find: jest.fn(() => ({
        sort: () => ({
          exec: () => Promise.resolve(asientos),
          session: () => ({ exec: () => Promise.resolve(asientos) }),
        }),
      })),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    const lotesModel = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(lote) })),
      findOneAndUpdate: jest.fn(
        (_filtro: unknown, cambio: { $set: Record<string, unknown> }) => ({
          exec: () => Promise.resolve(lote && { ...lote, ...cambio.$set }),
        }),
      ),
      create: jest.fn(),
    };
    const vacio = modeloCon([]);
    const recibosModel = modeloCon([
      { _id: reciboIdRC, prefijo: 'RC', numero: 10, observaciones: 'Pago' },
    ]);
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
      vacio as never,
      vacio as never,
      vacio as never,
      recibosModel as never,
      vacio as never,
      vacio as never,
      vacio as never,
      vacio as never,
      { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
      {
        obtenerUltimoConsolidado: jest.fn().mockResolvedValue({
          periodoDesde: new Date('2026-09-01'),
          periodoHasta: new Date('2026-09-30'),
        }),
      } as unknown as LotesFacturacionService,
      connection as never,
      undefined,
      undefined,
      conAuditoria ? (copropiedadesModel as never) : undefined,
      conAuditoria ? (auditoria as never) : undefined,
    );
    return { service, asientosModel, lotesModel, auditoria };
  };

  const copropiedadesModel = {
    findById: jest.fn(() => ({
      session: () => ({
        exec: () => Promise.resolve({ codigo: '0001', nombre: 'Edificio Uno' }),
      }),
    })),
  };
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  beforeEach(() => auditoria.registrar.mockClear());

  it('desmarcar libera los movimientos del lote y lo deja como historial desmarcado', async () => {
    const { service, asientosModel, lotesModel } = armar(loteDoc());

    const resultado = await service.desmarcar(LOTE_ID.toString(), ACTOR);

    expect(resultado).toMatchObject({ numero: 3, estado: 'desmarcado' });
    expect(resultado.fechaDesmarcado).not.toBeNull();
    expect(lotesModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: LOTE_ID, copropiedadId: COP, estado: { $ne: 'desmarcado' } },
      expect.anything(),
      expect.anything(),
    );
    expect(asientosModel.updateMany).toHaveBeenCalledWith(
      { copropiedadId: COP, contabilidadLoteId: LOTE_ID },
      {
        $set: {
          contabilidadLoteId: null,
          contabilidadLoteDesmarcadoId: LOTE_ID,
        },
      },
      expect.anything(),
    );
  });

  it('desmarcar queda en el registro de auditoría, dentro de la misma transacción', async () => {
    const { service } = armar(loteDoc({ totalAsientos: 12 }), true);

    await service.desmarcar(LOTE_ID.toString(), ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledWith(
      {
        actorAccountId: CUENTA,
        actorNombre: 'Contadora Pérez',
        accion: 'desmarcar',
        entidadTipo: 'lote-contabilidad',
        entidadId: LOTE_ID.toString(),
        entidadEtiqueta:
          'Lote 3 de Adición a Contabilidad de 0001 Edificio Uno desmarcado: 12 documentos vuelven a pendientes',
      },
      expect.anything(),
    );
  });

  it('generar un lote queda en el registro de auditoría', async () => {
    const { service, lotesModel } = armar(null, true);
    lotesModel.create.mockImplementation((docs: Record<string, unknown>[]) =>
      Promise.resolve(
        docs.map((d) => ({
          ...d,
          _id: LOTE_ID,
          createdAt: new Date('2026-09-10'),
        })),
      ),
    );
    (service as unknown as { consecutivosLote: unknown }).consecutivosLote = {
      findOneAndUpdate: () => ({
        exec: () => Promise.resolve({ nextNumber: 4 }),
      }),
    };

    await service.generar(ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'crear',
        entidadTipo: 'lote-contabilidad',
        entidadId: LOTE_ID.toString(),
        entidadEtiqueta:
          'Lote 4 de Adición a Contabilidad de 0001 Edificio Uno generado: 1 documento',
      }),
      expect.anything(),
    );
  });

  it('si el registro de auditoría falla, el desmarque no se confirma', async () => {
    const { service } = armar(loteDoc(), true);
    auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));

    await expect(service.desmarcar(LOTE_ID.toString(), ACTOR)).rejects.toThrow(
      'sin auditoría',
    );
  });

  it('no desmarca dos veces el mismo lote', async () => {
    const { service, asientosModel } = armar(loteDoc({ estado: 'desmarcado' }));

    await expect(service.desmarcar(LOTE_ID.toString(), ACTOR)).rejects.toThrow(
      'El lote 3 ya fue desmarcado.',
    );
    expect(asientosModel.updateMany).not.toHaveBeenCalled();
  });

  it('un lote que no es de esta copropiedad responde como inexistente', async () => {
    const { service, lotesModel } = armar(null);

    await expect(service.desmarcar(LOTE_ID.toString(), ACTOR)).rejects.toThrow(
      'No existe ese lote de contabilidad.',
    );
    expect(lotesModel.findOne).toHaveBeenCalledWith({
      _id: LOTE_ID,
      copropiedadId: COP,
    });
  });

  it('volver a descargar reconstruye los dos archivos con el número del lote', async () => {
    const { service, asientosModel } = armar(loteDoc());

    const archivos = await service.archivos(LOTE_ID.toString());

    expect(asientosModel.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      contabilidadLoteId: LOTE_ID,
    });
    expect(archivos.movmes).toContain('Pago');
    expect(archivos.movmesdo).toContain('1305');
    expect(archivos.movmesdo).toContain('4135');
  });

  it('un lote desmarcado ya no se puede volver a descargar', async () => {
    const { service } = armar(loteDoc({ estado: 'desmarcado' }));

    await expect(service.archivos(LOTE_ID.toString())).rejects.toThrow(
      'fue desmarcado',
    );
  });

  it('generar también toma los movimientos desmarcados aunque sean de otro período', async () => {
    const { service, asientosModel, lotesModel } = armar(null);
    lotesModel.create.mockImplementation((docs: Record<string, unknown>[]) =>
      Promise.resolve(
        docs.map((d) => ({
          ...d,
          _id: new Types.ObjectId(),
          createdAt: new Date('2026-09-10'),
        })),
      ),
    );
    (service as unknown as { consecutivosLote: unknown }).consecutivosLote = {
      findOneAndUpdate: () => ({
        exec: () => Promise.resolve({ nextNumber: 4 }),
      }),
    };

    await service.generar(ACTOR);

    expect(asientosModel.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      contabilidadLoteId: null,
      $or: [
        {
          fecha: {
            $gte: new Date('2026-09-01'),
            $lte: new Date('2026-09-30'),
          },
        },
        { contabilidadLoteDesmarcadoId: { $ne: null } },
      ],
    });
  });
});

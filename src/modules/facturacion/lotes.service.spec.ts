import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LotesFacturacionService } from './lotes.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';
import type { PeriodoService } from '../../common/contabilidad/periodo.service';

type Filtro = Record<string, unknown>;

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId().toString();

const loteDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'lote-1' },
  coPropertyId: COP,
  number: 1,
  status: 'borrador',
  billingDate: new Date('2026-08-27'),
  dueDate: new Date('2026-08-31'),
  periodStart: new Date('2026-08-01'),
  periodEnd: new Date('2026-08-31'),
  earlyPaymentDiscount: 0,
  discountGraceDays: 0,
  lateInterestRate: 0,
  lateInterestCap: null,
  adjustments: [],
  preview: [],
  invoiceIds: [],
  summary: null,
  generatedBy: { toString: () => CUENTA },
  ...over,
});

const lotesModeloCon = (opts: { activo?: Record<string, unknown> } = {}) => {
  const escrituras: Record<string, unknown>[] = [];
  return {
    escrituras,
    exists: jest.fn(() => ({
      exec: () => Promise.resolve(opts.activo ? { _id: 'x' } : null),
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve(loteDoc(doc));
    }),
  };
};

const numeracionCon = (numero = 1): NumeracionService =>
  ({
    siguienteLote: jest.fn().mockResolvedValue(numero),
  }) as unknown as NumeracionService;

const tenantQueDevuelve = (id: Types.ObjectId | null): TenantContextService =>
  ({
    resolveCoPropertyId: () => {
      if (id === null) throw new ForbiddenException('sin copropiedad activa');
      return id;
    },
  }) as unknown as TenantContextService;

describe('LotesFacturacionService.crear', () => {
  it('rechaza crear un lote nuevo si ya hay uno borrador o liquidado', async () => {
    const lotes = lotesModeloCon({ activo: {} });
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await expect(
      service.crear(CUENTA, {
        fechaFacturacion: '2026-08-27',
        fechaVencimiento: '2026-08-31',
        periodoDesde: '2026-08-01',
        periodoHasta: '2026-08-31',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(lotes.create).not.toHaveBeenCalled();
  });

  it('pide el número al servicio de numeración y lo guarda con los parámetros', async () => {
    const lotes = lotesModeloCon();
    const numeracion = numeracionCon(7);
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracion,
    );

    await service.crear(CUENTA, {
      fechaFacturacion: '2026-08-27',
      fechaVencimiento: '2026-08-31',
      periodoDesde: '2026-08-01',
      periodoHasta: '2026-08-31',
      interesMora: 1.9,
    });

    expect(lotes.escrituras[0]).toMatchObject({
      coPropertyId: COP,
      number: 7,
      status: 'borrador',
      lateInterestRate: 1.9,
      generatedBy: CUENTA,
    });
  });
});

describe('LotesFacturacionService.cargarNovedades', () => {
  const unidadCon = (id: string, codigo: string) => ({
    _id: id,
    code: codigo,
  });
  const conceptoCon = (id: string, nombre: string) => ({
    _id: id,
    name: nombre,
    active: true,
  });

  it('resuelve inmueble por código y concepto por nombre, y reemplaza las novedades anteriores', async () => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () =>
          Promise.resolve(loteDoc({ adjustments: [{ vieja: true }] })),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(({ code }: Filtro) => ({
        exec: () =>
          Promise.resolve(code === '301' ? unidadCon('inm-1', '301') : null),
      })),
    };
    const conceptos = {
      findOne: jest.fn(({ name }: Filtro) => ({
        exec: () =>
          Promise.resolve(
            name === 'Multas' ? conceptoCon('con-1', 'Multas') : null,
          ),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      conceptos as never,
      {} as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    const resultado = await service.cargarNovedades('lote-1', [
      { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 50000 },
    ]);

    expect(resultado).toEqual({ total: 1, cargadas: 1, errores: [] });
    const calls = lotes.findOneAndUpdate.mock.calls as unknown[][];
    const [, actualizacion] = calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(actualizacion.$set as Record<string, unknown>).toEqual({
      adjustments: [
        { inmuebleId: 'inm-1', conceptoId: 'con-1', amount: 50000, note: null },
      ],
    });
  });

  it('reporta por fila cuando el inmueble o el concepto no existen, sin abortar el resto', async () => {
    const lotes = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc()) })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(({ code }: Filtro) => ({
        exec: () =>
          Promise.resolve(code === '301' ? unidadCon('inm-1', '301') : null),
      })),
    };
    const conceptos = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(conceptoCon('con-1', 'Multas')),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      conceptos as never,
      {} as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    const resultado = await service.cargarNovedades('lote-1', [
      { inmuebleCodigo: '999', nombreConcepto: 'Multas', monto: 50000 },
      { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 20000 },
    ]);

    expect(resultado.cargadas).toBe(1);
    expect(resultado.errores).toEqual([
      { fila: 1, mensaje: 'No se encontró el inmueble con código "999"' },
    ]);
    const calls = lotes.findOneAndUpdate.mock.calls as unknown[][];
    const [, actualizacion] = calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(actualizacion.$set as Record<string, unknown>).toEqual({
      adjustments: [
        { inmuebleId: 'inm-1', conceptoId: 'con-1', amount: 20000, note: null },
      ],
    });
  });

  it('rechaza con NotFoundException si el lote no existe o pertenece a otra copropiedad', async () => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(null),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(null),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(({ code }: Filtro) => ({
        exec: () =>
          Promise.resolve(code === '301' ? unidadCon('inm-1', '301') : null),
      })),
    };
    const conceptos = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(conceptoCon('con-1', 'Multas')),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      conceptos as never,
      {} as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await expect(
      service.cargarNovedades('lote-inexistente', [
        { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 50000 },
      ]),
    ).rejects.toThrow('No se encontró el lote lote-inexistente');
  });

  it('rechaza cargar novedades en un lote que ya está consolidado', async () => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ status: 'consolidado' })),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(unidadCon('inm-1', '301')),
      })),
    };
    const conceptos = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(conceptoCon('con-1', 'Multas')),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      conceptos as never,
      {} as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await expect(
      service.cargarNovedades('lote-1', [
        { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 50000 },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(lotes.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('no encuentra un concepto inactivo (filtra por active: true)', async () => {
    const lotes = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc()) })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(unidadCon('inm-1', '301')),
      })),
    };
    const conceptos = {
      // Simulates a concept that exists but is inactive: the query filters
      // by active: true, so a filtered lookup finds nothing.
      findOne: jest.fn(({ active }: Filtro) => ({
        exec: () =>
          Promise.resolve(
            active === true ? null : conceptoCon('con-1', 'Multas'),
          ),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      conceptos as never,
      {} as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    const resultado = await service.cargarNovedades('lote-1', [
      { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 50000 },
    ]);

    expect(resultado.errores).toEqual([
      { fila: 1, mensaje: 'No se encontró el cargo "Multas"' },
    ]);
  });
});

describe('LotesFacturacionService.liquidar', () => {
  type ActualizacionLiquidar = {
    $set: {
      preview: Array<{
        lines: Array<Record<string, unknown>>;
        holder: Record<string, unknown> | null;
        terceroId: string | null;
      }>;
      status: string;
    };
  };
  const actualizacionDe = (mockFn: jest.Mock) => {
    const calls = mockFn.mock.calls as unknown[][];
    const [, actualizacion] = calls[0] as [unknown, ActualizacionLiquidar];
    return actualizacion;
  };

  const unidad = (over: Record<string, unknown> = {}) => ({
    _id: { toString: () => 'inm-1' },
    code: '301',
    coPropertyId: COP,
    holderId: { toString: () => 'ter-1' },
    status: 'active',
    ...over,
  });
  const tercero = (over: Record<string, unknown> = {}) => ({
    _id: { toString: () => 'ter-1' },
    name: 'Ana Pérez',
    identificationType: 'CC',
    identificationNumber: '123456',
    identificationVerificationDigit: null,
    address: null,
    city: null,
    email: null,
    ...over,
  });
  const concepto = (over: Record<string, unknown> = {}) => ({
    _id: { toString: () => 'con-1' },
    name: 'Administración',
    kind: 'administracion',
    taxRate: 0,
    accountingIncomeAccount: '413501',
    active: true,
    ...over,
  });
  const valorRecurrente = (over: Record<string, unknown> = {}) => ({
    inmuebleId: { toString: () => 'inm-1' },
    conceptoId: { toString: () => 'con-1' },
    amount: 520000,
    ...over,
  });

  const construirModelos = (opts: {
    unidades?: unknown[];
    terceros?: Record<string, unknown> | null;
    conceptos?: unknown[];
    valoresRecurrentes?: unknown[];
    saldos?: unknown[];
    lote?: Record<string, unknown>;
  }) => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc(opts.lote ?? {})),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc(opts.lote ?? {})),
      })),
    };
    const inmuebles = {
      find: jest.fn(() => ({
        exec: () => Promise.resolve(opts.unidades ?? [unidad()]),
      })),
    };
    const terceros = {
      findOne: jest.fn(() => ({
        exec: () =>
          Promise.resolve(
            opts.terceros === undefined ? tercero() : opts.terceros,
          ),
      })),
    };
    const conceptos = {
      find: jest.fn(() => ({
        exec: () => Promise.resolve(opts.conceptos ?? [concepto()]),
      })),
    };
    const valoresRecurrentes = {
      find: jest.fn(() => ({
        exec: () =>
          Promise.resolve(opts.valoresRecurrentes ?? [valorRecurrente()]),
      })),
    };
    const saldos = {
      find: jest.fn(() => ({
        exec: () => Promise.resolve(opts.saldos ?? []),
      })),
    };
    return {
      lotes,
      inmuebles,
      terceros,
      conceptos,
      valoresRecurrentes,
      saldos,
    };
  };

  it('arma una línea recurrente por cada ValorRecurrente y congela nombre/tasa/cuenta del concepto', async () => {
    const m = construirModelos({});
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const preliminar = actualizacion.$set.preview[0];
    expect(preliminar.lines).toEqual([
      expect.objectContaining({
        conceptName: 'Administración',
        conceptKind: 'administracion',
        accountingIncomeAccount: '413501',
        source: 'recurrente',
        baseAmount: 520000,
        totalAmount: 520000,
      }),
    ]);
    const linea = preliminar.lines[0] as { conceptoId: { toString(): string } };
    expect(linea.conceptoId.toString()).toBe('con-1');
    expect(actualizacion.$set.status).toBe('liquidado');
  });

  it('salta las unidades sin titular', async () => {
    const m = construirModelos({ unidades: [unidad({ holderId: null })] });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.preview).toEqual([]);
  });

  it('calcula el interés como % del saldo de cartera total, con tope, y lo omite si da cero', async () => {
    const m = construirModelos({
      conceptos: [
        concepto(),
        concepto({
          _id: { toString: () => 'con-intereses' },
          name: 'Interés por mora',
          kind: 'intereses',
          accountingIncomeAccount: '413595',
        }),
      ],
      saldos: [
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'c1',
          balance: 3000000,
        },
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'c2',
          balance: 1000000,
        },
      ],
      lote: { lateInterestRate: 1.9, lateInterestCap: 50000 },
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const interes = actualizacion.$set.preview[0].lines.find(
      (l: { source: string }) => l.source === 'interes',
    );
    // 1.9% of 4,000,000 = 76,000, capped at 50,000.
    expect(interes?.totalAmount).toBe(50000);
  });

  it('omite la línea de interés si el cálculo redondea a cero', async () => {
    const m = construirModelos({
      conceptos: [
        concepto(),
        concepto({
          _id: { toString: () => 'con-intereses' },
          name: 'Interés por mora',
          kind: 'intereses',
          accountingIncomeAccount: '413595',
        }),
      ],
      saldos: [
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'c1',
          balance: 10,
        },
      ],
      lote: { lateInterestRate: 1.9, lateInterestCap: 50000 },
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const lineas = actualizacion.$set.preview[0].lines;
    // 1.9% of 10 = 0.19, rounds to 0 — no interest line should be pushed.
    expect(
      lineas.some((l) => (l as { source: string }).source === 'interes'),
    ).toBe(false);
  });

  it('deja holder y terceroId en null si el titular no se encuentra', async () => {
    const m = construirModelos({ terceros: null });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const preliminar = actualizacion.$set.preview[0];
    expect(preliminar.holder).toBeNull();
    expect(preliminar.terceroId).toBeNull();
  });

  it('rechaza liquidar un lote que ya está consolidado', async () => {
    const m = construirModelos({ lote: { status: 'consolidado' } });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await expect(service.liquidar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.lotes.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('omite el preview de una unidad sin cargos recurrentes, sin novedades y sin interés', async () => {
    const m = construirModelos({ valoresRecurrentes: [] });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.preview).toEqual([]);
  });
});

describe('LotesFacturacionService.consolidar', () => {
  const preliminar = (over: Record<string, unknown> = {}) => ({
    inmuebleId: 'inm-1',
    unitCode: '301',
    terceroId: 'ter-1',
    holder: { name: 'Ana Pérez', identificationNumber: '123456' },
    lines: [
      {
        conceptoId: 'con-1',
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
    ...over,
  });

  type ActualizacionConsolidar = {
    $set: {
      status: string;
      invoiceIds: string[];
      summary: Record<string, unknown> | null;
    };
  };
  const actualizacionDe = (mockFn: jest.Mock) => {
    const calls = mockFn.mock.calls as unknown[][];
    const [, actualizacion] = calls[0] as [unknown, ActualizacionConsolidar];
    return actualizacion;
  };

  const construirModelos = (opts: {
    preview?: unknown[];
    copropiedad?: Record<string, unknown>;
    facturasExistentes?: Record<string, unknown>[];
    asientosExistentes?: Record<string, unknown>[];
  }) => {
    const facturasCreadas: Record<string, unknown>[] = [];
    const saldosActualizados: Filtro[] = [];
    const asientosCreados: Record<string, unknown>[] = [];

    const lotes = {
      findOne: jest.fn(() => ({
        exec: () =>
          Promise.resolve(
            loteDoc({
              status: 'liquidado',
              preview: opts.preview ?? [preliminar()],
            }),
          ),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ status: 'consolidado' })),
      })),
    };
    const facturas = {
      // Resume support: an already-existing Factura for this Lote (from an
      // earlier partial attempt) must be visible before the loop starts, so
      // consolidar() can skip re-invoicing its unit.
      find: jest.fn(() => ({
        exec: () => Promise.resolve(opts.facturasExistentes ?? []),
      })),
      create: jest.fn((doc: Record<string, unknown>) => {
        facturasCreadas.push(doc);
        return Promise.resolve({
          _id: { toString: () => `fac-${facturasCreadas.length}` },
        });
      }),
    };
    const saldos = {
      findOneAndUpdate: jest.fn((filtro: Filtro) => {
        saldosActualizados.push(filtro);
        return { exec: () => Promise.resolve({}) };
      }),
    };
    const asientos = {
      // Resume support: which of the (possibly pre-existing) Facturas for
      // this Lote already have their AsientoContable posted.
      find: jest.fn(() => ({
        exec: () => Promise.resolve(opts.asientosExistentes ?? []),
      })),
      create: jest.fn((doc: Record<string, unknown>) => {
        asientosCreados.push(doc);
        return Promise.resolve(doc);
      }),
    };
    const copropiedades = {
      findById: jest.fn(() => ({
        exec: () =>
          Promise.resolve(opts.copropiedad ?? { receivablesAccount: '130501' }),
      })),
    };
    return {
      lotes,
      facturas,
      saldos,
      asientos,
      copropiedades,
      facturasCreadas,
      saldosActualizados,
      asientosCreados,
    };
  };

  const periodoAbierto = (): PeriodoService =>
    ({
      exigirAbierto: jest.fn().mockResolvedValue(undefined),
    }) as unknown as PeriodoService;

  it('numera, crea la factura, incrementa el saldo de cartera y postea el asiento, por cada fila', async () => {
    const m = construirModelos({});

    // NumeracionService.siguienteFactura is a distinct method from
    // siguienteLote — this describe block's stub needs both.
    const numeracion = {
      siguienteLote: jest.fn().mockResolvedValue(1),
      siguienteFactura: jest.fn().mockResolvedValue({
        prefijo: 'CONJ-2026',
        numero: 1041,
        completo: 'CONJ-2026-1041',
        resolucionId: new Types.ObjectId(),
      }),
    } as unknown as NumeracionService;

    // See the canonical constructor order pinned in Task 6, Step 5 — every
    // test in Tasks 7, 9, and 10 passes all twelve arguments in that exact
    // order, not just the ones a given test cares about.
    const servicio2 = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos — unused by consolidar()
      {} as never, // valoresRecurrentes — unused by consolidar()
      {} as never, // inmuebles — unused by consolidar()
      {} as never, // terceros — unused by consolidar()
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
    );

    const resultado = await servicio2.consolidar('lote-1');

    expect(m.facturasCreadas[0]).toMatchObject({
      fullNumber: 'CONJ-2026-1041',
      unitCode: '301',
      total: 520000,
      outstandingBalance: 520000,
      status: 'emitida',
    });
    expect(m.saldosActualizados[0]).toMatchObject({
      inmuebleId: 'inm-1',
      conceptoId: 'con-1',
    });
    expect(m.asientosCreados[0].entries).toHaveLength(2);
    expect(resultado.errores).toEqual([]);
  });

  it('exige el periodo abierto ANTES de numerar nada', async () => {
    const m = construirModelos({});
    const periodo = {
      exigirAbierto: jest
        .fn()
        .mockRejectedValue(new ConflictException('cerrado')),
    } as unknown as PeriodoService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodo,
      numeracionCon(),
    );

    await expect(service.consolidar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.facturas.create).not.toHaveBeenCalled();
  });

  it('detiene todo el lote si la resolución se agota a mitad de camino, sin reintentar fila por fila', async () => {
    const m = construirModelos({
      preview: [preliminar(), preliminar({ unitCode: '302' })],
    });
    // Kept as a separate reference and asserted on directly below — reading
    // it back off `numeracion` (typed as the real NumeracionService) is what
    // @typescript-eslint/unbound-method warns about; see the same pattern in
    // firebase-usuarios.service.spec.ts.
    const siguienteFactura = jest
      .fn()
      .mockResolvedValueOnce({
        prefijo: '',
        numero: 1,
        completo: '1',
        resolucionId: new Types.ObjectId(),
      })
      .mockRejectedValueOnce(new ConflictException('rango agotado'));
    const numeracion = {
      siguienteLote: jest.fn(),
      siguienteFactura,
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
    );

    const resultado = await service.consolidar('lote-1');

    expect(m.facturasCreadas).toHaveLength(1);
    expect(siguienteFactura).toHaveBeenCalledTimes(2);
    expect(resultado.lote.estado).not.toBe('consolidado');
    expect(resultado.errores).toEqual([
      { fila: 2, inmuebleCodigo: '302', mensaje: 'rango agotado' },
    ]);
    // The RETURNED contract matching 'liquidado' isn't enough on its own —
    // pin what was actually persisted too, since the mocked
    // findOneAndUpdate's resolved value is unrelated to its own $set.
    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.status).toBe('liquidado');
    expect(actualizacion.$set.summary).toBeNull();
  });

  it('rechaza consolidar un lote que ya está consolidado', async () => {
    const m = construirModelos({});
    m.lotes.findOne = jest.fn(() => ({
      exec: () => Promise.resolve(loteDoc({ status: 'consolidado' })),
    }));
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracionCon(),
    );

    await expect(service.consolidar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.facturas.create).not.toHaveBeenCalled();
  });

  it('rechaza consolidar un lote que nunca fue liquidado (borrador)', async () => {
    const m = construirModelos({});
    m.lotes.findOne = jest.fn(() => ({
      exec: () => Promise.resolve(loteDoc({ status: 'borrador', preview: [] })),
    }));
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracionCon(),
    );

    await expect(service.consolidar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.facturas.create).not.toHaveBeenCalled();
  });

  it('rechaza (sin guardar) un asiento desbalanceado en vez de posearlo', async () => {
    // A preliminar whose declared `total` does not match the sum of its
    // lines' totalAmount — the only way to get construirMovimientos to
    // produce an unbalanced entry, since it derives credits from the lines
    // but the debit from `total` directly.
    const m = construirModelos({
      preview: [preliminar({ total: 999999 })],
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracionCon(),
    );

    await expect(service.consolidar('lote-1')).rejects.toThrow(/desbalanceado/);
    expect(m.facturas.create).not.toHaveBeenCalled();
    expect(m.asientos.create).not.toHaveBeenCalled();
  });

  it('en un reintento, no vuelve a facturar una unidad que ya tiene Factura en este lote', async () => {
    // Simulates the second call after a first attempt stopped partway:
    // inm-1 already has a real Factura from that first attempt; inm-2 does
    // not yet.
    const m = construirModelos({
      preview: [
        preliminar(),
        preliminar({ inmuebleId: 'inm-2', unitCode: '302' }),
      ],
      facturasExistentes: [
        {
          _id: { toString: () => 'fac-previo' },
          inmuebleId: { toString: () => 'inm-1' },
          total: 520000,
        },
      ],
      // fac-previo's AsientoContable was already posted — this row is
      // genuinely done, not orphaned.
      asientosExistentes: [{ facturaId: { toString: () => 'fac-previo' } }],
    });
    // Kept as a separate reference and asserted on directly below — see the
    // same @typescript-eslint/unbound-method note above.
    const siguienteFactura = jest.fn().mockResolvedValue({
      prefijo: 'CONJ-2026',
      numero: 1042,
      completo: 'CONJ-2026-1042',
      resolucionId: new Types.ObjectId(),
    });
    const numeracion = {
      siguienteLote: jest.fn(),
      siguienteFactura,
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
    );

    const resultado = await service.consolidar('lote-1');

    // Only the not-yet-invoiced unit gets a NEW Factura.
    expect(m.facturasCreadas).toHaveLength(1);
    expect(m.facturasCreadas[0]).toMatchObject({ unitCode: '302' });
    expect(siguienteFactura).toHaveBeenCalledTimes(1);
    // The pre-existing invoice is carried forward, not dropped.
    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.invoiceIds).toEqual(
      expect.arrayContaining(['fac-previo', 'fac-1']),
    );
    expect(actualizacion.$set.status).toBe('consolidado');
    expect(
      (actualizacion.$set.summary as { totalAmount: number }).totalAmount,
    ).toBe(1040000);
    expect(resultado.errores).toEqual([]);
  });

  it('registra un error por fila (y sigue con las demás) si falla la escritura después de numerar', async () => {
    // Row 1's AsientoContable write fails after its Factura was already
    // created; row 2 is unrelated and must still complete normally — this
    // is a per-row data problem, not the global resolution-exhaustion
    // blocker, so the loop must continue, not break.
    const m = construirModelos({
      preview: [
        preliminar(),
        preliminar({ inmuebleId: 'inm-2', unitCode: '302' }),
      ],
    });
    m.asientos.create = jest
      .fn()
      .mockRejectedValueOnce(new Error('Mongo se cayó'))
      .mockResolvedValueOnce({}) as typeof m.asientos.create;
    // Kept as a separate reference and asserted on directly below — see the
    // same @typescript-eslint/unbound-method note above.
    const siguienteFactura = jest.fn().mockResolvedValue({
      prefijo: 'CONJ-2026',
      numero: 1042,
      completo: 'CONJ-2026-1042',
      resolucionId: new Types.ObjectId(),
    });
    const numeracion = {
      siguienteLote: jest.fn(),
      siguienteFactura,
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
    );

    const resultado = await service.consolidar('lote-1');

    // Both rows got a real number, both Facturas were created — the failure
    // happened only on row 1's journal posting.
    expect(siguienteFactura).toHaveBeenCalledTimes(2);
    expect(m.facturasCreadas).toHaveLength(2);
    expect(resultado.errores).toEqual([
      expect.objectContaining({ fila: 1, inmuebleCodigo: '301' }),
    ]);
    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.status).toBe('liquidado');
    expect(actualizacion.$set.summary).toBeNull();
  });

  it('nunca marca consolidado un lote con una factura previa incompleta (sin asiento)', async () => {
    // inm-1's Factura from an earlier attempt exists, but its
    // AsientoContable was never created — a prior per-row write failure
    // between facturas.create() and asientos.create(). inm-2 is fine.
    const m = construirModelos({
      preview: [
        preliminar(),
        preliminar({ inmuebleId: 'inm-2', unitCode: '302' }),
      ],
      facturasExistentes: [
        {
          _id: { toString: () => 'fac-huerfana' },
          inmuebleId: { toString: () => 'inm-1' },
          unitCode: '301',
          fullNumber: 'CONJ-2026-1040',
          total: 520000,
        },
      ],
      asientosExistentes: [], // no asiento for fac-huerfana
    });
    const numeracion = {
      siguienteLote: jest.fn(),
      siguienteFactura: jest.fn().mockResolvedValue({
        prefijo: 'CONJ-2026',
        numero: 1042,
        completo: 'CONJ-2026-1042',
        resolucionId: new Types.ObjectId(),
      }),
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
    );

    const resultado = await service.consolidar('lote-1');

    // inm-1 is NEVER re-invoiced (that would duplicate a real DIAN number)…
    expect(m.facturasCreadas).toHaveLength(1);
    expect(m.facturasCreadas[0]).toMatchObject({ unitCode: '302' });
    // …but the batch can never silently complete while it's unposted.
    expect(resultado.errores).toEqual([
      expect.objectContaining({
        inmuebleCodigo: '301',
        // expect.stringContaining()'s declared return type is `any` — cast
        // to keep the surrounding object literal's inferred type honest for
        // @typescript-eslint/no-unsafe-assignment.
        mensaje: expect.stringContaining('CONJ-2026-1040') as string,
      }),
    ]);
    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.status).toBe('liquidado');
    expect(actualizacion.$set.summary).toBeNull();
    // The orphaned invoice is still referenced — it exists, it just isn't
    // counted toward a completed summary.
    expect(actualizacion.$set.invoiceIds).toEqual(
      expect.arrayContaining(['fac-huerfana', 'fac-1']),
    );
  });
});

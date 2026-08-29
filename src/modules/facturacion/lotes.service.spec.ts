import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LotesFacturacionService } from './lotes.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';

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
  });

  it('resuelve inmueble por código y concepto por nombre, y reemplaza las novedades anteriores', async () => {
    const lotes = {
      findById: jest.fn(() => ({
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
      findById: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc()) })),
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
});

describe('LotesFacturacionService.liquidar', () => {
  type ActualizacionLiquidar = {
    $set: {
      preview: Array<{ lines: Array<Record<string, unknown>> }>;
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
    terceros?: Record<string, unknown>;
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
      findById: jest.fn(() => ({
        exec: () => Promise.resolve(opts.terceros ?? tercero()),
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
});

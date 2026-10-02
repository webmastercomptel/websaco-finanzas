import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { LotesFacturacionService } from './lotes.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';
import type { PeriodoService } from '../../common/contabilidad/periodo.service';
import type { TitularFactura } from '../../contracts';

type Filtro = Record<string, unknown>;

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId().toString();
const CONSECUTIVO_FV = new Types.ObjectId();
const ACTOR = { accountId: 'cuenta-actora', nombre: 'Ana Actora' };

const loteDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'lote-1' },
  copropiedadId: COP,
  numero: 1,
  estado: 'borrador',
  fechaFacturacion: new Date('2026-08-27'),
  fechaVencimiento: new Date('2026-08-31'),
  periodoDesde: new Date('2026-08-01'),
  periodoHasta: new Date('2026-08-31'),
  descuentoProntoPago: 0,
  valorFijoDescuentoProntoPago: 0,
  diasGraciaDescuento: 0,
  interesMora: 0,
  topeInteresMora: null,
  fechaLimiteDescuento: new Date('2026-08-27'),
  fechaSuspension: new Date('2026-08-31'),
  novedades: [],
  previsualizacion: [],
  facturaIds: [],
  resumen: null,
  generadoPor: { toString: () => CUENTA },
  ...over,
});

/** `ultimoConsolidado` es `null` por defecto — "esta copropiedad nunca
 *  consolidó nada", que es exactamente el caso en el que `crear()` no debe
 *  validar ninguna secuencia de fechas. Los tests que sí ejercitan esa
 *  validación pasan su propio lote con `fechaFacturacion`. */
const lotesModeloCon = (
  opts: {
    activo?: Record<string, unknown>;
    ultimoConsolidado?: Record<string, unknown> | null;
  } = {},
) => {
  const escrituras: Record<string, unknown>[] = [];
  return {
    escrituras,
    exists: jest.fn(() => ({
      exec: () => Promise.resolve(opts.activo ? { _id: 'x' } : null),
    })),
    findOne: jest.fn(() => ({
      sort: () => ({
        exec: () => Promise.resolve(opts.ultimoConsolidado ?? null),
      }),
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve(loteDoc(doc));
    }),
  };
};

/** `ValorRecurrente` model whose `find()` returns `valores` — what
 *  `agregarNovedadLinea`/`cargarNovedades` read to reject a manual charge
 *  that duplicates a recurrente concepto. */
const recurrentesCon = (
  valores: {
    inmuebleId: Types.ObjectId;
    conceptoId: Types.ObjectId;
    monto: number;
  }[],
) => ({
  find: jest.fn(() => ({ exec: () => Promise.resolve(valores) })),
});

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
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
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
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {
        findById: jest.fn(() => ({
          exec: () => Promise.resolve({ moraHabilitada: false }),
        })),
      } as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracion,
      {} as never, // connection
    );

    await service.crear(CUENTA, {
      fechaFacturacion: '2026-08-27',
      fechaVencimiento: '2026-08-31',
      periodoDesde: '2026-08-01',
      periodoHasta: '2026-08-31',
      interesMora: 1.9,
    });

    expect(lotes.escrituras[0]).toMatchObject({
      copropiedadId: COP,
      numero: 7,
      estado: 'borrador',
      interesMora: 1.9,
      generadoPor: CUENTA,
    });
  });

  it('sin interesMora en el DTO, usa la tasa de la copropiedad solo si moraHabilitada está activo', async () => {
    const lotes = lotesModeloCon();
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {
        findById: jest.fn(() => ({
          exec: () =>
            Promise.resolve({
              moraHabilitada: true,
              moraTasaInteres: 2.5,
              moraValorLimite: 50000,
            }),
        })),
      } as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(7),
      {} as never, // connection
    );

    await service.crear(CUENTA, {
      fechaFacturacion: '2026-08-27',
      fechaVencimiento: '2026-08-31',
      periodoDesde: '2026-08-01',
      periodoHasta: '2026-08-31',
    });

    expect(lotes.escrituras[0]).toMatchObject({
      interesMora: 2.5,
      topeInteresMora: 50000,
    });
  });

  it('sin interesMora en el DTO y moraHabilitada apagado, no cobra mora aunque haya una tasa guardada', async () => {
    // El toggle debe gatear el default de verdad — no basta con leer la
    // tasa e ignorar si está habilitada.
    const lotes = lotesModeloCon();
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {
        findById: jest.fn(() => ({
          exec: () =>
            Promise.resolve({
              moraHabilitada: false,
              moraTasaInteres: 2.5,
              moraValorLimite: 50000,
            }),
        })),
      } as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(7),
      {} as never, // connection
    );

    await service.crear(CUENTA, {
      fechaFacturacion: '2026-08-27',
      fechaVencimiento: '2026-08-31',
      periodoDesde: '2026-08-01',
      periodoHasta: '2026-08-31',
    });

    expect(lotes.escrituras[0]).toMatchObject({
      interesMora: 0,
    });
  });

  it('calcula fechaLimiteDescuento como fechaFacturacion + días de gracia - 1 cuando no se envía', async () => {
    const lotes = lotesModeloCon();
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {
        findById: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      } as never,
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.crear(CUENTA, {
      fechaFacturacion: '2026-09-01',
      fechaVencimiento: '2026-09-30',
      periodoDesde: '2026-09-01',
      periodoHasta: '2026-09-30',
      diasGraciaDescuento: 10,
    });

    const escritura = lotes.escrituras[0] as { fechaLimiteDescuento: Date };
    // 2026-09-01 + 10 días de gracia - 1 = 2026-09-10.
    expect(escritura.fechaLimiteDescuento.toISOString().slice(0, 10)).toBe(
      '2026-09-10',
    );
  });

  it('usa fechaLimiteDescuento y fechaSuspension enviadas en el DTO, sin recalcularlas', async () => {
    const lotes = lotesModeloCon();
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {
        findById: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      } as never,
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.crear(CUENTA, {
      fechaFacturacion: '2026-09-01',
      fechaVencimiento: '2026-09-30',
      periodoDesde: '2026-09-01',
      periodoHasta: '2026-09-30',
      diasGraciaDescuento: 10,
      fechaLimiteDescuento: '2026-09-15',
      fechaSuspension: '2026-10-05',
    });

    const escritura = lotes.escrituras[0] as {
      fechaLimiteDescuento: Date;
      fechaSuspension: Date;
    };
    expect(escritura.fechaLimiteDescuento.toISOString().slice(0, 10)).toBe(
      '2026-09-15',
    );
    expect(escritura.fechaSuspension.toISOString().slice(0, 10)).toBe(
      '2026-10-05',
    );
  });

  it('sin fechaSuspension en el DTO, usa periodoHasta', async () => {
    const lotes = lotesModeloCon();
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {
        findById: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      } as never,
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.crear(CUENTA, {
      fechaFacturacion: '2026-09-01',
      fechaVencimiento: '2026-09-30',
      periodoDesde: '2026-09-01',
      periodoHasta: '2026-09-30',
    });

    const escritura = lotes.escrituras[0] as { fechaSuspension: Date };
    expect(escritura.fechaSuspension.toISOString().slice(0, 10)).toBe(
      '2026-09-30',
    );
  });

  const dtoBase = () => ({
    fechaFacturacion: '2026-09-01',
    fechaVencimiento: '2026-09-30',
    periodoDesde: '2026-09-01',
    periodoHasta: '2026-09-30',
  });

  it('hereda el % de descuento de Parámetros cuando el DTO no manda ninguno de los dos', async () => {
    const lotes = lotesModeloCon();
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never,
      {} as never,
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        findById: jest.fn(() => ({
          exec: () =>
            Promise.resolve({
              descuentoHabilitado: true,
              descuentoPorcentaje: 5,
              descuentoValorFijo: 0,
            }),
        })),
      } as never,
      tenantQueDevuelve(COP),
      {} as never,
      numeracionCon(),
      {} as never, // connection
    );

    await service.crear(CUENTA, dtoBase());

    expect(lotes.escrituras[0]).toMatchObject({
      descuentoProntoPago: 5,
      valorFijoDescuentoProntoPago: 0,
    });
  });

  it('hereda el valor fijo cuando no hay % configurado en Parámetros', async () => {
    const lotes = lotesModeloCon();
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never,
      {} as never,
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        findById: jest.fn(() => ({
          exec: () =>
            Promise.resolve({
              descuentoHabilitado: true,
              descuentoPorcentaje: 0,
              descuentoValorFijo: 15000,
            }),
        })),
      } as never,
      tenantQueDevuelve(COP),
      {} as never,
      numeracionCon(),
      {} as never, // connection
    );

    await service.crear(CUENTA, dtoBase());

    expect(lotes.escrituras[0]).toMatchObject({
      descuentoProntoPago: 0,
      valorFijoDescuentoProntoPago: 15000,
    });
  });

  it('no hereda nada cuando descuentoHabilitado está apagado, aunque haya % o valor fijo guardados', async () => {
    const lotes = lotesModeloCon();
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never,
      {} as never,
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        findById: jest.fn(() => ({
          exec: () =>
            Promise.resolve({
              descuentoHabilitado: false,
              descuentoPorcentaje: 5,
              descuentoValorFijo: 15000,
            }),
        })),
      } as never,
      tenantQueDevuelve(COP),
      {} as never,
      numeracionCon(),
      {} as never, // connection
    );

    await service.crear(CUENTA, dtoBase());

    expect(lotes.escrituras[0]).toMatchObject({
      descuentoProntoPago: 0,
      valorFijoDescuentoProntoPago: 0,
    });
  });

  it('respeta lo que el DTO ya trae explícito, sin heredar de Parámetros', async () => {
    const lotes = lotesModeloCon();
    const copropiedades = {
      findById: jest.fn(() => ({
        exec: () =>
          Promise.resolve({
            descuentoHabilitado: true,
            descuentoPorcentaje: 5,
            descuentoValorFijo: 0,
          }),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never,
      {} as never,
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      copropiedades as never,
      tenantQueDevuelve(COP),
      {} as never,
      numeracionCon(),
      {} as never, // connection
    );

    await service.crear(CUENTA, { ...dtoBase(), descuentoProntoPago: 8 });

    expect(lotes.escrituras[0]).toMatchObject({
      descuentoProntoPago: 8,
      valorFijoDescuentoProntoPago: 0,
    });
  });

  const servicioCon = (lotes: ReturnType<typeof lotesModeloCon>) =>
    new LotesFacturacionService(
      lotes as never,
      {} as never,
      {} as never,
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        findById: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      } as never,
      tenantQueDevuelve(COP),
      {} as never,
      numeracionCon(),
      {} as never, // connection
    );

  it('rechaza una fecha de facturación que no cae en el mes siguiente al último ciclo consolidado — el bug real reportado (typo de año)', async () => {
    const lotes = lotesModeloCon({
      ultimoConsolidado: { fechaFacturacion: new Date('2026-08-01') },
    });
    const service = servicioCon(lotes);

    // El typo real: "9202" en vez de "2026" como año.
    await expect(
      service.crear(CUENTA, { ...dtoBase(), fechaFacturacion: '9202-10-02' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lotes.escrituras).toHaveLength(0);
  });

  it('acepta la fecha de facturación cuando cae exactamente en el mes siguiente al último ciclo consolidado', async () => {
    const lotes = lotesModeloCon({
      ultimoConsolidado: { fechaFacturacion: new Date('2026-08-01') },
    });
    const service = servicioCon(lotes);

    await service.crear(CUENTA, {
      ...dtoBase(),
      fechaFacturacion: '2026-09-15',
    });

    expect(lotes.escrituras).toHaveLength(1);
  });

  it('rechaza una fecha de facturación del mismo mes que el último ciclo consolidado (no avanzó el período)', async () => {
    const lotes = lotesModeloCon({
      ultimoConsolidado: { fechaFacturacion: new Date('2026-08-01') },
    });
    const service = servicioCon(lotes);

    await expect(
      service.crear(CUENTA, { ...dtoBase(), fechaFacturacion: '2026-08-20' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maneja el cruce de año — diciembre consolidado exige enero del año siguiente', async () => {
    const lotes = lotesModeloCon({
      ultimoConsolidado: { fechaFacturacion: new Date('2026-12-01') },
    });
    const service = servicioCon(lotes);

    await service.crear(CUENTA, {
      ...dtoBase(),
      fechaFacturacion: '2027-01-10',
    });

    expect(lotes.escrituras).toHaveLength(1);
  });

  it('no valida nada cuando la copropiedad nunca ha consolidado un lote (primer ciclo libre)', async () => {
    const lotes = lotesModeloCon({ ultimoConsolidado: null });
    const service = servicioCon(lotes);

    await service.crear(CUENTA, {
      ...dtoBase(),
      fechaFacturacion: '2020-01-01',
    });

    expect(lotes.escrituras).toHaveLength(1);
  });
});

describe('LotesFacturacionService.crearIndividual', () => {
  const INMUEBLE = new Types.ObjectId().toString();

  const inmueblesCon = (encontrado: Record<string, unknown> | null) => ({
    findOne: jest.fn(() => ({ exec: () => Promise.resolve(encontrado) })),
  });

  const servicioCon = (
    lotes: ReturnType<typeof lotesModeloCon>,
    inmuebles: ReturnType<typeof inmueblesCon>,
    numeracion = numeracionCon(9),
  ) =>
    new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracion,
      {} as never, // connection
    );

  it('rechaza si ya hay un lote en curso', async () => {
    const lotes = lotesModeloCon({ activo: {} });
    const inmuebles = inmueblesCon({ _id: INMUEBLE });
    const service = servicioCon(lotes, inmuebles);

    await expect(
      service.crearIndividual(CUENTA, { inmuebleId: INMUEBLE }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(lotes.create).not.toHaveBeenCalled();
  });

  it('rechaza si el inmueble no existe en esta copropiedad', async () => {
    const lotes = lotesModeloCon();
    const inmuebles = inmueblesCon(null);
    const service = servicioCon(lotes, inmuebles);

    await expect(
      service.crearIndividual(CUENTA, { inmuebleId: INMUEBLE }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(lotes.create).not.toHaveBeenCalled();
  });

  it('rechaza si la copropiedad nunca consolidó un lote — no hay período actual al cual pertenecer', async () => {
    const lotes = lotesModeloCon({ ultimoConsolidado: null });
    const inmuebles = inmueblesCon({ _id: INMUEBLE });
    const service = servicioCon(lotes, inmuebles);

    await expect(
      service.crearIndividual(CUENTA, { inmuebleId: INMUEBLE }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(lotes.create).not.toHaveBeenCalled();
  });

  it('copia fechas y parámetros del último lote consolidado, nunca de Copropiedad ni de un valor libre', async () => {
    const ultimoConsolidado = {
      fechaFacturacion: new Date('2026-08-27'),
      fechaVencimiento: new Date('2026-08-31'),
      periodoDesde: new Date('2026-08-01'),
      periodoHasta: new Date('2026-08-31'),
      descuentoProntoPago: 5,
      valorFijoDescuentoProntoPago: 0,
      diasGraciaDescuento: 3,
      interesMora: 1.9,
      topeInteresMora: 50000,
      fechaLimiteDescuento: new Date('2026-08-29'),
      fechaSuspension: new Date('2026-08-31'),
    };
    const lotes = lotesModeloCon({ ultimoConsolidado });
    const inmuebles = inmueblesCon({ _id: INMUEBLE });
    const service = servicioCon(lotes, inmuebles, numeracionCon(9));

    await service.crearIndividual(CUENTA, { inmuebleId: INMUEBLE });

    expect(lotes.escrituras[0]).toMatchObject({
      copropiedadId: COP,
      numero: 9,
      estado: 'borrador',
      inmuebleId: new Types.ObjectId(INMUEBLE),
      generadoPor: CUENTA,
      ...ultimoConsolidado,
    });
  });
});

describe('LotesFacturacionService.agregarNovedadLinea', () => {
  const INMUEBLE_LOTE = new Types.ObjectId().toString();
  const OTRO_INMUEBLE = new Types.ObjectId().toString();
  const CONCEPTO = new Types.ObjectId().toString();

  const servicioCon = (lote: Record<string, unknown>) => {
    const lotesModelo = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc(lote)) })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc(lote)),
      })),
    };
    const inmueblesModelo = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve({ _id: OTRO_INMUEBLE }),
      })),
    };
    const conceptosModelo = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve({ _id: CONCEPTO, tipo: 'administracion' }),
      })),
    };
    const service = new LotesFacturacionService(
      lotesModelo as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      conceptosModelo as never,
      recurrentesCon([]) as never, // valoresRecurrentes
      inmueblesModelo as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );
    return { service, lotesModelo };
  };

  it('rechaza un cargo para otro inmueble cuando el lote es una Factura Individual', async () => {
    const { service, lotesModelo } = servicioCon({
      inmuebleId: { toString: () => INMUEBLE_LOTE },
    });

    await expect(
      service.agregarNovedadLinea('lote-1', {
        inmuebleId: OTRO_INMUEBLE,
        conceptoId: CONCEPTO,
        amount: 100000,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(lotesModelo.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('un lote normal (sin inmuebleId) admite cargos de cualquier inmueble', async () => {
    const { service, lotesModelo } = servicioCon({});

    await service.agregarNovedadLinea('lote-1', {
      inmuebleId: OTRO_INMUEBLE,
      conceptoId: CONCEPTO,
      amount: 100000,
    });

    expect(lotesModelo.findOneAndUpdate).toHaveBeenCalled();
  });

  describe('cargo duplicado del mismo concepto', () => {
    const INMUEBLE = new Types.ObjectId();
    const MULTAS = new Types.ObjectId();

    const servicio = (
      lote: Record<string, unknown>,
      recurrentes: Parameters<typeof recurrentesCon>[0],
    ) => {
      const lotesModelo = {
        findOne: jest.fn(() => ({
          exec: () => Promise.resolve(loteDoc(lote)),
        })),
        findOneAndUpdate: jest.fn(() => ({
          exec: () => Promise.resolve(loteDoc(lote)),
        })),
      };
      const service = new LotesFacturacionService(
        lotesModelo as never,
        {} as never, // facturas
        {} as never, // saldos
        {} as never, // carteraPorDocumento
        {} as never, // saldoTotalDocumento
        {} as never, // asientos
        {
          findOne: jest.fn(() => ({
            exec: () =>
              Promise.resolve({ _id: MULTAS, nombre: 'Multas', tipo: 'otro' }),
          })),
        } as never,
        recurrentesCon(recurrentes) as never,
        {
          findOne: jest.fn(() => ({
            exec: () => Promise.resolve({ _id: INMUEBLE, codigo: '11002' }),
          })),
        } as never,
        {} as never, // terceros
        {} as never, // copropiedades
        tenantQueDevuelve(COP),
        {} as never, // periodo
        numeracionCon(),
        {} as never, // connection
      );
      return { service, lotesModelo };
    };

    const agregarMultas = (service: LotesFacturacionService) =>
      service.agregarNovedadLinea('lote-1', {
        inmuebleId: INMUEBLE.toString(),
        conceptoId: MULTAS.toString(),
        amount: 100000,
      });

    it('rechaza agregar un cargo manual de un concepto que el inmueble ya tiene como recurrente — obliga a editarlo', async () => {
      const { service, lotesModelo } = servicio({}, [
        { inmuebleId: INMUEBLE, conceptoId: MULTAS, monto: 50000 },
      ]);

      await expect(agregarMultas(service)).rejects.toThrow(
        'El inmueble 11002 ya tiene un cargo de "Multas" en este lote (cargo recurrente). Edite ese cargo en lugar de agregar uno nuevo.',
      );
      expect(lotesModelo.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rechaza un segundo cargo manual del mismo concepto para el mismo inmueble', async () => {
      const { service } = servicio(
        {
          novedades: [
            {
              inmuebleId: INMUEBLE,
              conceptoId: MULTAS,
              monto: 30000,
              sobrescribe: null,
            },
          ],
        },
        [],
      );

      await expect(agregarMultas(service)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('permite el cargo cuando el recurrente fue sobrescrito en 0 (esa línea no se factura)', async () => {
      const { service, lotesModelo } = servicio(
        {
          novedades: [
            {
              inmuebleId: INMUEBLE,
              conceptoId: MULTAS,
              monto: 0,
              sobrescribe: 'recurrente',
            },
          ],
        },
        [{ inmuebleId: INMUEBLE, conceptoId: MULTAS, monto: 50000 }],
      );

      await agregarMultas(service);

      expect(lotesModelo.findOneAndUpdate).toHaveBeenCalled();
    });
  });
});

describe('LotesFacturacionService.cargarNovedades', () => {
  const unidadCon = (id: string, codigo: string) => ({
    _id: id,
    codigo,
  });
  const conceptoCon = (id: string, nombre: string) => ({
    _id: id,
    nombre,
  });

  it('resuelve inmueble por código y concepto por nombre, y agrega la novedad sin reemplazar las anteriores', async () => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ novedades: [{ vieja: true }] })),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(({ codigo }: Filtro) => ({
        exec: () =>
          Promise.resolve(codigo === '301' ? unidadCon('inm-1', '301') : null),
      })),
    };
    const conceptos = {
      findOne: jest.fn(({ nombre }: Filtro) => ({
        exec: () =>
          Promise.resolve(
            nombre === 'Multas' ? conceptoCon('con-1', 'Multas') : null,
          ),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      conceptos as never,
      recurrentesCon([]) as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    const resultado = await service.cargarNovedades('lote-1', [
      { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 50000 },
    ]);

    expect(resultado).toEqual({ total: 1, cargadas: 1, errores: [] });
    const calls = lotes.findOneAndUpdate.mock.calls as unknown[][];
    const [, actualizacion] = calls[0] as [
      Record<string, unknown>,
      { $push: { novedades: { $each: Record<string, unknown>[] } } },
    ];
    // ADDITIVE now: $push (not $set) — a fresh upload must never wipe
    // whatever novedades already existed on the lote.
    expect(actualizacion.$push.novedades.$each).toEqual([
      expect.objectContaining({
        inmuebleId: 'inm-1',
        conceptoId: 'con-1',
        monto: 50000,
        nota: null,
        sobrescribe: null,
      }),
    ]);
  });

  it('reporta por fila cuando el inmueble o el concepto no existen, sin abortar el resto', async () => {
    const lotes = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc()) })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(({ codigo }: Filtro) => ({
        exec: () =>
          Promise.resolve(codigo === '301' ? unidadCon('inm-1', '301') : null),
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
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      conceptos as never,
      recurrentesCon([]) as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
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
      { $push: { novedades: { $each: Record<string, unknown>[] } } },
    ];
    expect(actualizacion.$push.novedades.$each).toEqual([
      expect.objectContaining({
        inmuebleId: 'inm-1',
        conceptoId: 'con-1',
        monto: 20000,
        nota: null,
        sobrescribe: null,
      }),
    ]);
  });

  it('reporta como error la fila cuyo concepto el inmueble ya tiene como recurrente, y la segunda fila repetida del mismo archivo', async () => {
    const INMUEBLE = new Types.ObjectId();
    const MULTAS = new Types.ObjectId();
    const PARQUEADERO = new Types.ObjectId();
    const lotes = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc()) })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {
        findOne: jest.fn(({ nombre }: Filtro) => ({
          exec: () =>
            Promise.resolve(
              nombre === 'Multas'
                ? { _id: MULTAS, nombre: 'Multas' }
                : { _id: PARQUEADERO, nombre: 'Parqueadero' },
            ),
        })),
      } as never,
      recurrentesCon([
        { inmuebleId: INMUEBLE, conceptoId: MULTAS, monto: 50000 },
      ]) as never,
      {
        findOne: jest.fn(() => ({
          exec: () => Promise.resolve({ _id: INMUEBLE, codigo: '11002' }),
        })),
      } as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    const resultado = await service.cargarNovedades('lote-1', [
      { inmuebleCodigo: '11002', nombreConcepto: 'Multas', monto: 100000 },
      { inmuebleCodigo: '11002', nombreConcepto: 'Parqueadero', monto: 40000 },
      { inmuebleCodigo: '11002', nombreConcepto: 'Parqueadero', monto: 40000 },
    ]);

    expect(resultado.cargadas).toBe(1);
    expect(resultado.errores.map((e) => e.fila)).toEqual([1, 3]);
    expect(resultado.errores[0].mensaje).toContain('cargo recurrente');
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
      findOne: jest.fn(({ codigo }: Filtro) => ({
        exec: () =>
          Promise.resolve(codigo === '301' ? unidadCon('inm-1', '301') : null),
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
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      conceptos as never,
      recurrentesCon([]) as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
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
        exec: () => Promise.resolve(loteDoc({ estado: 'consolidado' })),
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
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      conceptos as never,
      recurrentesCon([]) as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await expect(
      service.cargarNovedades('lote-1', [
        { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 50000 },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(lotes.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rechaza un concepto que no está habilitado para novedades', async () => {
    // El concepto SÍ existe, solo le falta el flag — probando que
    // cargaXls realmente filtra, no solo que un concepto
    // inexistente falla. No hay más un flag active/inactive separado en
    // ConceptoCobro (design note en el schema): cargaXls es todo
    // lo que la consulta filtra además del nombre.
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
    const conceptosFindOne = jest.fn((filtro: Filtro) => ({
      exec: () =>
        Promise.resolve(
          filtro.cargaXls === true
            ? null // este concepto existe pero NO tiene el flag — la
            : // consulta real (con el filtro correcto) no lo encuentra
              conceptoCon('con-1', 'Multas'),
        ),
    }));
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      { findOne: conceptosFindOne } as never,
      recurrentesCon([]) as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    const resultado = await service.cargarNovedades('lote-1', [
      { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 50000 },
    ]);

    expect(conceptosFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ cargaXls: true }),
    );
    expect(resultado.errores).toEqual([
      {
        fila: 1,
        mensaje:
          'No se encontró el cargo "Multas" o no está habilitado para novedades',
      },
    ]);
    expect(resultado.cargadas).toBe(0);
  });
});

describe('LotesFacturacionService.actualizar', () => {
  const actualizacionDe = (mockFn: jest.Mock) => {
    const calls = mockFn.mock.calls as unknown[][];
    const [, actualizacion] = calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    return actualizacion.$set;
  };

  const construir = (lotes: unknown) =>
    new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

  it('rechaza editar un lote consolidado: ya generó facturas reales', async () => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ estado: 'consolidado' })),
      })),
      findOneAndUpdate: jest.fn(),
    };
    const service = construir(lotes);

    await expect(
      service.actualizar('lote-1', { fechaFacturacion: '2026-09-01' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(lotes.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('lanza NotFoundException si el lote no existe para esta copropiedad', async () => {
    const lotes = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      findOneAndUpdate: jest.fn(),
    };
    const service = construir(lotes);

    await expect(
      service.actualizar('lote-ajeno', { fechaFacturacion: '2026-09-01' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('guarda solo los campos que vinieron en el patch', async () => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ estado: 'liquidado' })),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ estado: 'borrador' })),
      })),
    };
    const service = construir(lotes);

    await service.actualizar('lote-1', {
      fechaFacturacion: '2026-09-01',
      interesMora: 2.1,
    });

    const guardado = actualizacionDe(lotes.findOneAndUpdate);
    expect(guardado.fechaFacturacion).toEqual(new Date('2026-09-01'));
    expect(guardado.interesMora).toBe(2.1);
    expect(guardado).not.toHaveProperty('fechaVencimiento');
    expect(guardado).not.toHaveProperty('periodoDesde');
  });

  it('siempre vuelve a borrador y borra la previsualización — ya no corresponde a los parámetros nuevos', async () => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () =>
          Promise.resolve(
            loteDoc({
              estado: 'liquidado',
              previsualizacion: [{ inmuebleId: 'x' }],
            }),
          ),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ estado: 'borrador' })),
      })),
    };
    const service = construir(lotes);

    await service.actualizar('lote-1', { interesMora: 1 });

    const guardado = actualizacionDe(lotes.findOneAndUpdate);
    expect(guardado.estado).toBe('borrador');
    expect(guardado.previsualizacion).toEqual([]);
    expect(guardado.resumen).toBeNull();
  });

  it('no toca novedades: las novedades ya cargadas no dependen del período', async () => {
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ estado: 'liquidado' })),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ estado: 'borrador' })),
      })),
    };
    const service = construir(lotes);

    await service.actualizar('lote-1', { interesMora: 1 });

    expect(actualizacionDe(lotes.findOneAndUpdate)).not.toHaveProperty(
      'novedades',
    );
  });
});

describe('LotesFacturacionService.liquidar', () => {
  type ActualizacionLiquidar = {
    $set: {
      previsualizacion: Array<{
        lineas: Array<Record<string, unknown>>;
        titular: Record<string, unknown> | null;
        terceroId: string | null;
      }>;
      estado: string;
    };
  };
  const actualizacionDe = (mockFn: jest.Mock) => {
    const calls = mockFn.mock.calls as unknown[][];
    const [, actualizacion] = calls[0] as [unknown, ActualizacionLiquidar];
    return actualizacion;
  };

  const unidad = (over: Record<string, unknown> = {}) => ({
    _id: { toString: () => 'inm-1' },
    codigo: '301',
    copropiedadId: COP,
    titularId: { toString: () => 'ter-1' },
    estado: 'active',
    ...over,
  });
  const tercero = (over: Record<string, unknown> = {}) => ({
    _id: { toString: () => 'ter-1' },
    nombre: 'Ana Pérez',
    tipoIdentificacion: 'CC',
    numeroIdentificacion: '123456',
    digitoVerificacion: null,
    direccion: null,
    ciudad: null,
    emails: [],
    telefono: null,
    ...over,
  });
  const concepto = (over: Record<string, unknown> = {}) => ({
    _id: { toString: () => 'con-1' },
    nombre: 'Administración',
    tipo: 'administracion',
    tasaImpuesto: 0,
    liquidaMora: true,
    cuentaCreditoId: { codigo: '413501' },
    ...over,
  });
  const valorRecurrente = (over: Record<string, unknown> = {}) => ({
    inmuebleId: { toString: () => 'inm-1' },
    conceptoId: { toString: () => 'con-1' },
    monto: 520000,
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
      // construirPreview() now batches this via `find({ _id: { $in } })`
      // instead of a per-unit `findOne` — `opts.terceros` stays a single
      // nullable object (every existing test here only ever cares about one
      // unit's tercero), just wrapped into the array `find()` returns.
      find: jest.fn(() => ({
        exec: () => {
          const resultado =
            opts.terceros === undefined ? tercero() : opts.terceros;
          return Promise.resolve(resultado ? [resultado] : []);
        },
      })),
    };
    const conceptos = {
      find: jest.fn(() => {
        const cadena = {
          populate: () => cadena,
          exec: () => Promise.resolve(opts.conceptos ?? [concepto()]),
        };
        return cadena;
      }),
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
    // liquidar() never touches CarteraPorDocumento/SaldoTotalDocumento (only
    // consolidar() does) — empty stubs, just so these tests' constructor
    // calls (which pass every argument, unused ones included) still
    // typecheck.
    const carteraPorDocumento = {};
    const saldoTotalDocumento = {};
    return {
      lotes,
      inmuebles,
      carteraPorDocumento,
      saldoTotalDocumento,
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
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const preliminar = actualizacion.$set.previsualizacion[0];
    expect(preliminar.lineas).toEqual([
      expect.objectContaining({
        nombreConcepto: 'Administración',
        tipoConcepto: 'administracion',
        cuentaIngreso: '413501',
        origen: 'recurrente',
        valorBase: 520000,
        valorTotal: 520000,
      }),
    ]);
    const linea = preliminar.lineas[0] as {
      conceptoId: { toString(): string };
    };
    expect(linea.conceptoId.toString()).toBe('con-1');
    expect(actualizacion.$set.estado).toBe('liquidado');
  });

  it('solo trae inmuebles activos para el previsualizacion — un inmueble marcado inactivo no entra a un ciclo nuevo', async () => {
    // `Inmueble.estado` (product decision, 2026-09-21): un inmueble inactivo
    // nunca debe generar Factura en un ciclo nuevo — la consulta que arma
    // el previsualizacion es la única elegibilidad real, así que basta con
    // verificar que siempre filtra por `estado: 'active'`.
    const m = construirModelos({});
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const llamadas = (m.inmuebles.find as jest.Mock).mock.calls as unknown[][];
    const filtro = llamadas[0]?.[0] as Record<string, unknown> | undefined;
    expect(filtro?.estado).toBe('active');
  });

  it('congela cuentaImpuesto desde cuentaImpuestoId del concepto', async () => {
    const m = construirModelos({
      conceptos: [
        concepto({ tasaImpuesto: 19, cuentaImpuestoId: { codigo: '240815' } }),
      ],
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const preliminar = actualizacion.$set.previsualizacion[0];
    expect(preliminar.lineas).toEqual([
      expect.objectContaining({
        cuentaImpuesto: '240815',
        tasaImpuesto: 19,
        valorBase: 520000,
        valorImpuesto: Math.round(520000 * 0.19),
        valorTotal: 520000 + Math.round(520000 * 0.19),
      }),
    ]);
  });

  it('ordena las líneas por orden del cargo (Administración, Intereses, Multas), no por orden de cómputo', async () => {
    // El orden de cómputo real es recurrente -> novedades -> interés (interés
    // siempre al final, para poder calcularlo sobre el saldo ya cargado), pero
    // el orden que debe verse en la factura y en el asiento es el de la
    // pestaña de Cargos: Administración, Intereses, Multas.
    const m = construirModelos({
      conceptos: [
        concepto({
          _id: { toString: () => 'con-admin' },
          nombre: 'Administración',
          tipo: 'administracion',
          orden: 1,
          cuentaCreditoId: { codigo: '413501' },
        }),
        concepto({
          _id: { toString: () => 'con-intereses' },
          nombre: 'Intereses por Mora',
          tipo: 'intereses',
          orden: 2,
          cuentaCreditoId: { codigo: '413595' },
        }),
        concepto({
          _id: { toString: () => 'con-multas' },
          nombre: 'Multas',
          tipo: 'otro',
          orden: 3,
          cuentaCreditoId: { codigo: '413599' },
        }),
      ],
      valoresRecurrentes: [
        valorRecurrente({ conceptoId: { toString: () => 'con-admin' } }),
      ],
      saldos: [
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'con-admin',
          saldoPendiente: 500000,
        },
      ],
      lote: {
        interesMora: 1.9,
        topeInteresMora: null,
        novedades: [
          {
            _id: { toString: () => 'nov-multas' },
            inmuebleId: { toString: () => 'inm-1' },
            conceptoId: { toString: () => 'con-multas' },
            monto: 50000,
            sobrescribe: null,
          },
        ],
      },
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const nombres = actualizacion.$set.previsualizacion[0].lineas.map(
      (l) => (l as { nombreConcepto: string }).nombreConcepto,
    );
    expect(nombres).toEqual(['Administración', 'Intereses por Mora', 'Multas']);
  });

  it('salta las unidades sin titular', async () => {
    const m = construirModelos({ unidades: [unidad({ titularId: null })] });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.previsualizacion).toEqual([]);
  });

  it('calcula el interés como % del saldo ANTERIOR de todos los cargos con "liquida mora" prendido, ignorando los que lo tienen apagado y el propio concepto de intereses', async () => {
    const m = construirModelos({
      conceptos: [
        concepto(), // con-1, Administración, liquidaMora: true
        concepto({
          _id: { toString: () => 'con-pintura' },
          nombre: 'Pintura',
          tipo: 'otro',
          liquidaMora: true,
        }),
        concepto({
          _id: { toString: () => 'con-multas' },
          nombre: 'Multas',
          tipo: 'otro',
          liquidaMora: false,
        }),
        concepto({
          _id: { toString: () => 'con-intereses' },
          nombre: 'Interés por mora',
          tipo: 'intereses',
          // Prendido a propósito: igual NO debe entrar a la base
          // (no se cobra interés sobre interés).
          liquidaMora: true,
          cuentaCreditoId: { codigo: '413595' },
        }),
      ],
      saldos: [
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'con-1', // Administración
          saldoPendiente: 2000000,
        },
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'con-pintura',
          saldoPendiente: 1000000,
        },
        // Multas tiene la casilla apagada — no suma, por grande que sea.
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'con-multas',
          saldoPendiente: 1000000,
        },
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'con-intereses',
          saldoPendiente: 500000,
        },
      ],
      // Base = 2,000,000 (Administración) + 1,000,000 (Pintura) = 3,000,000,
      // supera el mínimo de 50,000: 1.9% de 3,000,000 = 57,000.
      lote: { interesMora: 1.9, topeInteresMora: 50000 },
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const interes = actualizacion.$set.previsualizacion[0].lineas.find(
      (l: { origen: string }) => l.origen === 'interes',
    );
    expect(interes?.valorTotal).toBe(57000);
  });

  it('Factura Individual (lote.inmuebleId set): ignora ValorRecurrente y la mora automática — solo lo cargado a mano', async () => {
    const m = construirModelos({
      conceptos: [
        concepto(), // con-1, tipo: 'administracion'
        concepto({
          _id: { toString: () => 'con-intereses' },
          nombre: 'Interés por mora',
          tipo: 'intereses',
          cuentaCreditoId: { codigo: '413595' },
        }),
      ],
      // Saldo vencido que, en un lote normal, SÍ dispararía mora automática
      // (1.9% de 3,000,000 = 57,000, muy por encima del mínimo de 50,000).
      saldos: [
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'con-1',
          saldoPendiente: 3000000,
        },
      ],
      lote: {
        inmuebleId: { toString: () => 'inm-1' },
        interesMora: 1.9,
        topeInteresMora: 50000,
        novedades: [
          {
            _id: { toString: () => 'nov-1' },
            inmuebleId: { toString: () => 'inm-1' },
            conceptoId: { toString: () => 'con-1' },
            monto: 300000,
            nota: 'Cargo manual',
            sobrescribe: null,
          },
        ],
      },
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    // ValorRecurrente nunca se consulta — todo se carga a mano.
    expect(m.valoresRecurrentes.find).not.toHaveBeenCalled();

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const lineas = actualizacion.$set.previsualizacion[0].lineas as Array<{
      origen: string;
      valorTotal: number;
    }>;
    expect(lineas.some((l) => l.origen === 'interes')).toBe(false);
    expect(lineas.some((l) => l.origen === 'recurrente')).toBe(false);
    expect(lineas).toEqual([
      expect.objectContaining({ origen: 'novedad', valorTotal: 300000 }),
    ]);
  });

  it('omite la mora cuando el saldo no alcanza el mínimo configurado', async () => {
    const m = construirModelos({
      conceptos: [
        concepto(),
        concepto({
          _id: { toString: () => 'con-intereses' },
          nombre: 'Interés por mora',
          tipo: 'intereses',
          cuentaCreditoId: { codigo: '413595' },
        }),
      ],
      saldos: [
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'con-1', // Administración
          saldoPendiente: 30000,
        },
      ],
      // 10% de 30,000 = 3,000 (no redondearía a cero), pero el saldo no
      // alcanza el mínimo de 50,000 — no se cobra mora en absoluto.
      lote: { interesMora: 10, topeInteresMora: 50000 },
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const interes = actualizacion.$set.previsualizacion[0].lineas.find(
      (l: { origen: string }) => l.origen === 'interes',
    );
    expect(interes).toBeUndefined();
  });

  it('omite la línea de interés si el cálculo redondea a cero', async () => {
    const m = construirModelos({
      conceptos: [
        concepto(),
        concepto({
          _id: { toString: () => 'con-intereses' },
          nombre: 'Interés por mora',
          tipo: 'intereses',
          cuentaCreditoId: { codigo: '413595' },
        }),
      ],
      saldos: [
        {
          inmuebleId: { toString: () => 'inm-1' },
          conceptoId: 'con-1', // Administración
          saldoPendiente: 10,
        },
      ],
      lote: { interesMora: 1.9, topeInteresMora: 50000 },
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const lineas = actualizacion.$set.previsualizacion[0].lineas;
    // 1.9% of 10 = 0.19, rounds to 0 — no interest line should be pushed.
    expect(
      lineas.some((l) => (l as { origen: string }).origen === 'interes'),
    ).toBe(false);
  });

  it('congela solo el primer email cuando el titular tiene varios', async () => {
    const m = construirModelos({
      terceros: tercero({ emails: ['ana@ejemplo.com', 'gestor@ejemplo.com'] }),
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const preliminar = actualizacion.$set.previsualizacion[0];
    expect(preliminar.titular?.email).toBe('ana@ejemplo.com');
  });

  it('congela el teléfono del titular en titular.telefono', async () => {
    const m = construirModelos({
      terceros: tercero({ telefono: '3108458405' }),
    });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const preliminar = actualizacion.$set.previsualizacion[0];
    expect(preliminar.titular?.telefono).toBe('3108458405');
  });

  it('deja titular y terceroId en null si el titular no se encuentra', async () => {
    const m = construirModelos({ terceros: null });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const preliminar = actualizacion.$set.previsualizacion[0];
    expect(preliminar.titular).toBeNull();
    expect(preliminar.terceroId).toBeNull();
  });

  it('rechaza liquidar un lote que ya está consolidado', async () => {
    const m = construirModelos({ lote: { estado: 'consolidado' } });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await expect(service.liquidar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.lotes.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('omite el previsualizacion de una unidad sin cargos recurrentes, sin novedades y sin interés', async () => {
    const m = construirModelos({ valoresRecurrentes: [] });
    const service = new LotesFacturacionService(
      m.lotes as never,
      {} as never, // facturas
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      {} as never, // asientos
      m.conceptos as never,
      m.valoresRecurrentes as never,
      m.inmuebles as never,
      m.terceros as never,
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    await service.liquidar('lote-1');

    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.previsualizacion).toEqual([]);
  });
});

describe('LotesFacturacionService.consolidar', () => {
  /** Runs `fn` synchronously — no real transaction, matching how
   *  recibos.service.spec.ts stubs the same `connection.startSession()` /
   *  `session.withTransaction()` pair for RecibosService. */
  const sesionFalsa = () => ({
    withTransaction: (fn: () => Promise<unknown>) => fn(),
    endSession: jest.fn(() => Promise.resolve(undefined)),
  });

  const conexionCon = (session: ReturnType<typeof sesionFalsa>) =>
    ({ startSession: jest.fn(() => Promise.resolve(session)) }) as never;

  const preliminar = (over: Record<string, unknown> = {}) => ({
    inmuebleId: 'inm-1',
    codigoInmueble: '301',
    terceroId: 'ter-1',
    titular: { nombre: 'Ana Pérez', numeroIdentificacion: '123456' },
    lineas: [
      {
        conceptoId: 'con-1',
        nombreConcepto: 'Administración',
        tipoConcepto: 'administracion',
        cuentaIngreso: '413501',
        origen: 'recurrente',
        valorBase: 520000,
        tasaImpuesto: 0,
        valorImpuesto: 0,
        valorTotal: 520000,
      },
    ],
    subtotal: 520000,
    totalImpuestos: 0,
    total: 520000,
    ...over,
  });

  type ActualizacionConsolidar = {
    $set: {
      estado: string;
      facturaIds: string[];
      resumen: Record<string, unknown> | null;
    };
  };
  const actualizacionDe = (mockFn: jest.Mock) => {
    // The first findOneAndUpdate is the run's claim (progreso); the final
    // estado/facturaIds/resumen write is the last one.
    const calls = mockFn.mock.calls as unknown[][];
    const [, actualizacion] = calls[calls.length - 1] as [
      unknown,
      ActualizacionConsolidar,
    ];
    return actualizacion;
  };

  const construirModelos = (opts: {
    previsualizacion?: unknown[];
    copropiedad?: Record<string, unknown>;
    facturasExistentes?: Record<string, unknown>[];
    asientosExistentes?: Record<string, unknown>[];
    cuentasContables?: Record<string, unknown>[];
    lote?: Record<string, unknown>;
  }) => {
    const facturasCreadas: Record<string, unknown>[] = [];
    const saldosActualizados: Filtro[] = [];
    const carteraPorDocumentoCreados: Record<string, unknown>[] = [];
    const saldoTotalDocumentoCreados: Record<string, unknown>[] = [];
    const asientosCreados: Record<string, unknown>[] = [];

    const lotes = {
      findOne: jest.fn(() => ({
        exec: () =>
          Promise.resolve(
            loteDoc({
              estado: 'liquidado',
              previsualizacion: opts.previsualizacion ?? [preliminar()],
              ...opts.lote,
            }),
          ),
      })),
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc({ estado: 'consolidado' })),
      })),
      // Progress tracking. Declares both parameters (even where a given
      // test doesn't assert on the call) so jest infers a two-element call
      // tuple — see the same note on numeracion.service.spec.ts's
      // resolucionesCon.
      updateOne: jest.fn((_filtro?: Filtro, _actualizacion?: Filtro) => ({
        exec: () => Promise.resolve({}),
      })),
    };
    const facturas = {
      // Resume support: an already-existing Factura for this Lote (from an
      // earlier partial attempt) must be visible before the loop starts, so
      // consolidar() can skip re-invoicing its unit.
      // `lean()` is what `deshacerConsolidacion` chains before `exec()`.
      find: jest.fn(() => ({
        exec: () => Promise.resolve(opts.facturasExistentes ?? []),
        lean: () => ({
          exec: () => Promise.resolve(opts.facturasExistentes ?? []),
        }),
      })),
      deleteMany: jest.fn((_filtro?: Filtro, _opciones?: Filtro) =>
        Promise.resolve({ deletedCount: 0 }),
      ),
      // Array + options form (`create([doc], { session })`), matching the
      // per-row Mongo transaction — the mock ignores `opts` (no real
      // session/transaction semantics in these tests, same simplification
      // as recibos.service.spec.ts's own `sesionFalsa`).
      create: jest.fn((docs: Record<string, unknown>[]) => {
        const doc = docs[0];
        facturasCreadas.push(doc);
        return Promise.resolve([
          { ...doc, _id: { toString: () => `fac-${facturasCreadas.length}` } },
        ]);
      }),
      // Batched via `insertMany` (one call per tanda) instead of one
      // `create` per row — every Factura doc already carries its own
      // pre-assigned real `_id`, set by `prepararFilaParaConsolidar`, so
      // the mock only needs to record what it was given.
      insertMany: jest.fn((docs: Record<string, unknown>[]) => {
        facturasCreadas.push(...docs);
        return Promise.resolve(docs);
      }),
    };
    const saldos = {
      // consolidar() reads the current balance per concept, fresh, right
      // before its own increment — defaults to "nothing owed yet" here
      // since none of these tests assert on balanceBefore/After values.
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      // Batched via `find({ inmuebleId: { $in }, conceptoId: { $in } })`
      // instead of a per-row-per-line `findOne` — same "nothing owed yet"
      // default as above, just as an empty array instead of null.
      find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
      // One bulkWrite per row (was one findOneAndUpdate per line) — records
      // each op's filter, same shape tests already assert on.
      bulkWrite: jest.fn((ops: { updateOne: { filter: Filtro } }[]) => {
        for (const op of ops) saldosActualizados.push(op.updateOne.filter);
        return Promise.resolve({});
      }),
    };
    const carteraPorDocumento = {
      deleteMany: jest.fn((_filtro?: Filtro, _opciones?: Filtro) =>
        Promise.resolve({ deletedCount: 0 }),
      ),
      // Seeds this Factura's own per-línea row in the new ledger, alongside
      // `saldos.bulkWrite` above — records what was inserted, same reason.
      insertMany: jest.fn((docs: Record<string, unknown>[]) => {
        carteraPorDocumentoCreados.push(...docs);
        return Promise.resolve(docs);
      }),
    };
    const saldoTotalDocumento = {
      deleteMany: jest.fn((_filtro?: Filtro, _opciones?: Filtro) =>
        Promise.resolve({ deletedCount: 0 }),
      ),
      // Seeds this Factura's own atomically-guarded total-balance row.
      create: jest.fn((docs: Record<string, unknown>[]) => {
        saldoTotalDocumentoCreados.push(...docs);
        return Promise.resolve(docs);
      }),
      // Batched via `insertMany` (one call per tanda) instead of one
      // `create` per row — see `facturas.insertMany`'s own comment above.
      insertMany: jest.fn((docs: Record<string, unknown>[]) => {
        saldoTotalDocumentoCreados.push(...docs);
        return Promise.resolve(docs);
      }),
    };
    const asientos = {
      deleteMany: jest.fn((_filtro?: Filtro, _opciones?: Filtro) =>
        Promise.resolve({ deletedCount: 0 }),
      ),
      // Resume support: which of the (possibly pre-existing) Facturas for
      // this Lote already have their AsientoContable posted.
      find: jest.fn((filtro?: Filtro) => ({
        exec: () => Promise.resolve(opts.asientosExistentes ?? []),
        // `deshacerConsolidacion`'s orphan guard (`.lean().exec()`): by
        // default every requested Factura has its asiento (echoed back).
        lean: () => ({
          exec: () =>
            Promise.resolve(
              (
                (filtro?.facturaId as { $in?: unknown[] } | undefined)?.$in ??
                []
              ).map((facturaId) => ({ facturaId })),
            ),
        }),
      })),
      // Array + options form, same reason as facturas.create above.
      create: jest.fn((docs: Record<string, unknown>[]) => {
        const doc = docs[0];
        asientosCreados.push(doc);
        return Promise.resolve([doc]);
      }),
      // Batched via `insertMany` (one call per tanda) instead of one
      // `create` per row — see `facturas.insertMany`'s own comment above.
      insertMany: jest.fn((docs: Record<string, unknown>[]) => {
        asientosCreados.push(...docs);
        return Promise.resolve(docs);
      }),
    };
    const copropiedades = {
      findById: jest.fn(() => ({
        exec: () =>
          Promise.resolve(
            opts.copropiedad ?? { cuentaContableCartera: '130501' },
          ),
      })),
    };
    const cuentasContables = {
      find: jest.fn(() => ({
        exec: () => Promise.resolve(opts.cuentasContables ?? []),
      })),
    };
    return {
      lotes,
      facturas,
      saldos,
      carteraPorDocumento,
      saldoTotalDocumento,
      asientos,
      copropiedades,
      cuentasContables,
      facturasCreadas,
      saldosActualizados,
      carteraPorDocumentoCreados,
      saldoTotalDocumentoCreados,
      asientosCreados,
    };
  };

  const periodoAbierto = (): PeriodoService =>
    ({
      exigirAbierto: jest.fn().mockResolvedValue(undefined),
    }) as unknown as PeriodoService;

  /** Mocks reservarBloqueFacturas granting the FULL amount requested,
   *  starting from `base.numero` and incrementing per slot — mirrors an
   *  active resolution (or FV consecutivo, when `resolucionId` is omitted)
   *  with plenty of range left. Mirrors what a single fixed
   *  `siguienteFactura` mock used to stand in for, before consolidar()
   *  switched to reserving the whole block in one call. */
  const numeracionQueOtorgaTodo = (base: {
    prefijo: string;
    numero: number;
    resolucionId?: Types.ObjectId;
  }) =>
    jest.fn((_coPropertyId: string, cantidad: number) =>
      Promise.resolve({
        numeros: Array.from({ length: cantidad }, (_, i) => ({
          prefijo: base.prefijo,
          numero: base.numero + i,
          completo: base.prefijo
            ? `${base.prefijo}-${base.numero + i}`
            : String(base.numero + i),
          ...(base.resolucionId !== undefined
            ? { resolucionId: base.resolucionId }
            : {}),
        })),
      }),
    );

  it('numera, crea la factura, incrementa el saldo de cartera y postea el asiento, por cada fila', async () => {
    const m = construirModelos({});

    // NumeracionService.reservarBloqueFacturas is a distinct method from
    // siguienteLote — this describe block's stub needs both.
    const numeracion = {
      siguienteLote: jest.fn().mockResolvedValue(1),
      reservarBloqueFacturas: numeracionQueOtorgaTodo({
        prefijo: 'CONJ-2026',
        numero: 1041,
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
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos — unused by consolidar()
      {} as never, // valoresRecurrentes — unused by consolidar()
      {} as never, // inmuebles — unused by consolidar()
      {} as never, // terceros — unused by consolidar()
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
    );

    const resultado = await servicio2.consolidar('lote-1');

    expect(m.facturasCreadas[0]).toMatchObject({
      numeroCompleto: 'CONJ-2026-1041',
      codigoInmueble: '301',
      total: 520000,
      saldoPendiente: 520000,
      estado: 'emitida',
    });
    expect(m.saldosActualizados[0]).toMatchObject({
      inmuebleId: 'inm-1',
      conceptoId: 'con-1',
    });
    expect(m.asientosCreados[0].movimientos).toHaveLength(2);
    expect(resultado.errores).toEqual([]);
  });

  it('actualiza el progreso mientras procesa las filas, y lo limpia al terminar', async () => {
    const m = construirModelos({
      previsualizacion: [
        preliminar(),
        preliminar({ inmuebleId: 'inm-2', codigoInmueble: '302' }),
        preliminar({ inmuebleId: 'inm-3', codigoInmueble: '303' }),
      ],
    });
    const numeracion = {
      siguienteLote: jest.fn().mockResolvedValue(1),
      reservarBloqueFacturas: numeracionQueOtorgaTodo({
        prefijo: 'CONJ-2026',
        numero: 1041,
        resolucionId: new Types.ObjectId(),
      }),
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
    );

    await service.consolidar('lote-1');

    // First write, before any row is attempted: 0 of 3.
    const escrituras = m.lotes.updateOne.mock.calls.map(
      ([, actualizacion]) =>
        (actualizacion as { $set: { progreso: unknown } }).$set.progreso,
    );
    expect(escrituras[0]).toEqual({ actual: 0, total: 3 });
    // Last progress write reaches the full count — every row completed.
    expect(escrituras[escrituras.length - 1]).toEqual({
      actual: 3,
      total: 3,
    });
    // The final findOneAndUpdate (estado/facturaIds/resumen) clears it —
    // nothing left to poll once consolidar() itself has returned.
    const actualizacionFinal = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacionFinal.$set).toMatchObject({ progreso: null });
  });

  it('agrega tercero/centroCosto/flujoCaja a las líneas cuya cuenta lo requiere', async () => {
    const m = construirModelos({
      copropiedad: {
        cuentaContableCartera: '130501',
        centroCostoDefecto: 'CC-01',
        flujoCajaCodigo: 'FC-OPER',
      },
      cuentasContables: [
        {
          codigo: '130501',
          requiereTercero: true,
          centroUtilidad: false,
          centroDestino: false,
          flujoCaja: false,
        },
        {
          codigo: '413501',
          requiereTercero: false,
          centroUtilidad: true,
          centroDestino: false,
          flujoCaja: true,
        },
      ],
    });
    const numeracion = {
      siguienteLote: jest.fn().mockResolvedValue(1),
      reservarBloqueFacturas: numeracionQueOtorgaTodo({
        prefijo: 'FV',
        numero: 1,
      }),
    } as unknown as NumeracionService;

    const servicio2 = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos — unused by consolidar()
      {} as never, // valoresRecurrentes — unused by consolidar()
      {} as never, // inmuebles — unused by consolidar()
      {} as never, // terceros — unused by consolidar()
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
      m.cuentasContables as never,
    );

    await servicio2.consolidar('lote-1');

    const movimientos = m.asientosCreados[0].movimientos as Array<{
      cuenta: string;
      tercero?: string | null;
      centroCosto?: string | null;
      flujoCaja?: string | null;
    }>;
    const debitoCartera = movimientos.find((e) => e.cuenta === '130501');
    const creditoIngreso = movimientos.find((e) => e.cuenta === '413501');
    expect(debitoCartera?.tercero).toBe('301');
    expect(debitoCartera?.centroCosto ?? null).toBeNull();
    expect(creditoIngreso?.centroCosto).toBe('CC-01');
    expect(creditoIngreso?.flujoCaja).toBe('FC-OPER');
  });

  it('guarda resolucionId null cuando reservarBloqueFacturas usó el consecutivo FV de respaldo', async () => {
    // Sin resolución DIAN activa, reservarBloqueFacturas ya no incluye
    // resolucionId — la factura debe quedar con null, no con un valor
    // inventado por un non-null assertion.
    const m = construirModelos({});
    const numeracion = {
      siguienteLote: jest.fn().mockResolvedValue(1),
      reservarBloqueFacturas: numeracionQueOtorgaTodo({
        prefijo: 'FV',
        numero: 1,
      }),
    } as unknown as NumeracionService;

    const servicio2 = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos — unused by consolidar()
      {} as never, // valoresRecurrentes — unused by consolidar()
      {} as never, // inmuebles — unused by consolidar()
      {} as never, // terceros — unused by consolidar()
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
    );

    await servicio2.consolidar('lote-1');

    expect(m.facturasCreadas[0]).toMatchObject({
      numeroCompleto: 'FV-1',
      resolucionId: null,
    });
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
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodo,
      numeracionCon(),
      conexionCon(sesionFalsa()),
    );

    await expect(service.consolidar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.facturas.create).not.toHaveBeenCalled();
  });

  it('detiene todo el lote si la resolución se agota a mitad de camino, sin reintentar fila por fila', async () => {
    const m = construirModelos({
      previsualizacion: [preliminar(), preliminar({ codigoInmueble: '302' })],
    });
    // Kept as a separate reference and asserted on directly below — reading
    // it back off `numeracion` (typed as the real NumeracionService) is what
    // @typescript-eslint/unbound-method warns about; see the same pattern in
    // firebase-usuarios.service.spec.ts. Grants only 1 of the 2 requested —
    // reservarBloqueFacturas returning fewer than asked is now what a
    // mid-batch exhaustion looks like (a single reserve call replaces the
    // old per-row siguienteFactura calls, so there's no "Nth call rejects"
    // anymore — the shortfall itself IS the exhaustion signal).
    const reservarBloqueFacturas = jest.fn().mockResolvedValue({
      numeros: [
        {
          prefijo: '',
          numero: 1,
          completo: '1',
          resolucionId: new Types.ObjectId(),
        },
      ],
    });
    const numeracion = {
      siguienteLote: jest.fn(),
      reservarBloqueFacturas,
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
    );

    const resultado = await service.consolidar('lote-1');

    expect(m.facturasCreadas).toHaveLength(1);
    // ONE call reserving both rows' worth up front, not one call per row.
    expect(reservarBloqueFacturas).toHaveBeenCalledTimes(1);
    expect(reservarBloqueFacturas).toHaveBeenCalledWith(COP.toString(), 2);
    expect(resultado.lote.estado).not.toBe('consolidado');
    expect(resultado.errores).toEqual([
      {
        fila: 2,
        inmuebleCodigo: '302',
        mensaje:
          'Se agotó el rango de numeración disponible para este lote ' +
          '(se pudieron numerar 1 de 2 facturas). Hay que cargar una ' +
          'resolución nueva.',
      },
    ]);
    // The RETURNED contract matching 'liquidado' isn't enough on its own —
    // pin what was actually persisted too, since the mocked
    // findOneAndUpdate's resolved value is unrelated to its own $set.
    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.estado).toBe('liquidado');
    expect(actualizacion.$set.resumen).toBeNull();
  });

  it('rechaza consolidar un lote que ya está consolidado', async () => {
    const m = construirModelos({});
    m.lotes.findOne = jest.fn(() => ({
      exec: () => Promise.resolve(loteDoc({ estado: 'consolidado' })),
    }));
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracionCon(),
      conexionCon(sesionFalsa()),
    );

    await expect(service.consolidar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.facturas.create).not.toHaveBeenCalled();
  });

  it('rechaza consolidar un lote que nunca fue liquidado (borrador)', async () => {
    const m = construirModelos({});
    m.lotes.findOne = jest.fn(() => ({
      exec: () =>
        Promise.resolve(loteDoc({ estado: 'borrador', previsualizacion: [] })),
    }));
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracionCon(),
      conexionCon(sesionFalsa()),
    );

    await expect(service.consolidar('lote-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(m.facturas.create).not.toHaveBeenCalled();
  });

  it('un preliminar cuyo total declarado no coincide con la suma de sus líneas sigue generando un asiento balanceado', async () => {
    // construirMovimientos derives BOTH the debit and credit sides from the
    // lineas' own valorTotal (one partitioned by cuentaCartera,
    // the other by cuentaIngreso) — a stale/wrong `preliminar.total`
    // no longer unbalances the posting, since `total` is never read for the
    // debit side anymore. See the "Asiento contable desbalanceado" check in
    // consolidar() for the (now unreachable via this path) defense-in-depth
    // it still guards.
    const m = construirModelos({
      previsualizacion: [preliminar({ total: 999999 })],
    });
    const numeracion = {
      siguienteLote: jest.fn().mockResolvedValue(1),
      reservarBloqueFacturas: numeracionQueOtorgaTodo({
        prefijo: 'FV',
        numero: 1,
      }),
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
    );

    await expect(service.consolidar('lote-1')).resolves.toBeDefined();
    expect(m.facturas.insertMany).toHaveBeenCalled();
    expect(m.asientos.insertMany).toHaveBeenCalled();
  });

  it('en un reintento, no vuelve a facturar una unidad que ya tiene Factura en este lote', async () => {
    // Simulates the second call after a first attempt stopped partway:
    // inm-1 already has a real Factura from that first attempt; inm-2 does
    // not yet.
    const m = construirModelos({
      previsualizacion: [
        preliminar(),
        preliminar({ inmuebleId: 'inm-2', codigoInmueble: '302' }),
      ],
      facturasExistentes: [
        {
          _id: { toString: () => 'fac-previo' },
          inmuebleId: { toString: () => 'inm-1' },
          total: 520000,
          numero: 1041,
          numeroCompleto: 'CONJ-2026-1041',
        },
      ],
      // fac-previo's AsientoContable was already posted — this row is
      // genuinely done, not orphaned.
      asientosExistentes: [{ facturaId: { toString: () => 'fac-previo' } }],
    });
    // Kept as a separate reference and asserted on directly below — see the
    // same @typescript-eslint/unbound-method note above.
    const reservarBloqueFacturas = numeracionQueOtorgaTodo({
      prefijo: 'CONJ-2026',
      numero: 1042,
      resolucionId: new Types.ObjectId(),
    });
    const numeracion = {
      siguienteLote: jest.fn(),
      reservarBloqueFacturas,
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
    );

    const resultado = await service.consolidar('lote-1');

    // Only the not-yet-invoiced unit gets a NEW Factura.
    expect(m.facturasCreadas).toHaveLength(1);
    expect(m.facturasCreadas[0]).toMatchObject({ codigoInmueble: '302' });
    // Reserved exactly 1 — the already-invoiced unit never counted toward
    // the block size (unidadesYaFacturadas already excluded it).
    expect(reservarBloqueFacturas).toHaveBeenCalledTimes(1);
    expect(reservarBloqueFacturas).toHaveBeenCalledWith(COP.toString(), 1);
    // The pre-existing invoice is carried forward, not dropped. The new
    // invoice's id is whatever `prepararFilaParaConsolidar` pre-assigned
    // (a real ObjectId, not a mock-synthesized string) — read back off the
    // mock's own record of what was inserted, rather than hardcoding it.
    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    const idNuevaFactura = (
      m.facturasCreadas[0]._id as Types.ObjectId
    ).toString();
    expect(actualizacion.$set.facturaIds).toEqual(
      expect.arrayContaining(['fac-previo', idNuevaFactura]),
    );
    expect(actualizacion.$set.estado).toBe('consolidado');
    expect(actualizacion.$set.resumen).toMatchObject({
      montoTotal: 1040000,
      primerNumero: 'CONJ-2026-1041',
      ultimoNumero: 'CONJ-2026-1042',
    });
    expect(resultado.errores).toEqual([]);
  });

  it('un error de escritura tras numerar registra un error por CADA fila de la tanda que lo contenía', async () => {
    // Both rows land in the SAME tanda (default size 20, far above 2 rows),
    // so their Factura/SaldoTotalDocumento/Asiento writes all run inside
    // ONE Mongo transaction — a single `asientos.insertMany` covers both,
    // not one call per row any more. Its rejection rolls back the WHOLE
    // tanda: both rows are recorded as errors, not just the one whose write
    // actually failed — the accepted tradeoff documented on
    // `procesarTanda()` for batching several rows per transaction.
    const m = construirModelos({
      previsualizacion: [
        preliminar(),
        preliminar({ inmuebleId: 'inm-2', codigoInmueble: '302' }),
      ],
    });
    m.asientos.insertMany = jest
      .fn()
      .mockRejectedValueOnce(
        new Error('Mongo se cayó'),
      ) as typeof m.asientos.insertMany;
    // Kept as a separate reference and asserted on directly below — see the
    // same @typescript-eslint/unbound-method note above.
    const reservarBloqueFacturas = numeracionQueOtorgaTodo({
      prefijo: 'CONJ-2026',
      numero: 1042,
      resolucionId: new Types.ObjectId(),
    });
    const numeracion = {
      siguienteLote: jest.fn(),
      reservarBloqueFacturas,
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
    );

    const resultado = await service.consolidar('lote-1');

    // Both rows got a real number (reserved together, in one call) — the
    // failure happened once, on the tanda's own journal-posting step.
    expect(reservarBloqueFacturas).toHaveBeenCalledTimes(1);
    expect(reservarBloqueFacturas).toHaveBeenCalledWith(COP.toString(), 2);
    expect(m.asientos.insertMany).toHaveBeenCalledTimes(1);
    expect(resultado.errores).toEqual([
      expect.objectContaining({
        fila: 1,
        inmuebleCodigo: '301',
        mensaje: expect.stringContaining('Mongo se cayó') as string,
      }),
      expect.objectContaining({
        fila: 2,
        inmuebleCodigo: '302',
        mensaje: expect.stringContaining('Mongo se cayó') as string,
      }),
    ]);
    const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
    expect(actualizacion.$set.estado).toBe('liquidado');
    expect(actualizacion.$set.resumen).toBeNull();
  });

  it('nunca marca consolidado un lote con una factura previa incompleta (sin asiento)', async () => {
    // inm-1's Factura from an earlier attempt exists, but its
    // AsientoContable was never created — a prior per-row write failure
    // between facturas.create() and asientos.create(). inm-2 is fine.
    const m = construirModelos({
      previsualizacion: [
        preliminar(),
        preliminar({ inmuebleId: 'inm-2', codigoInmueble: '302' }),
      ],
      facturasExistentes: [
        {
          _id: { toString: () => 'fac-huerfana' },
          inmuebleId: { toString: () => 'inm-1' },
          codigoInmueble: '301',
          numeroCompleto: 'CONJ-2026-1040',
          total: 520000,
        },
      ],
      asientosExistentes: [], // no asiento for fac-huerfana
    });
    const numeracion = {
      siguienteLote: jest.fn(),
      reservarBloqueFacturas: numeracionQueOtorgaTodo({
        prefijo: 'CONJ-2026',
        numero: 1042,
        resolucionId: new Types.ObjectId(),
      }),
    } as unknown as NumeracionService;
    const service = new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracion,
      conexionCon(sesionFalsa()),
    );

    const resultado = await service.consolidar('lote-1');

    // inm-1 is NEVER re-invoiced (that would duplicate a real DIAN number)…
    expect(m.facturasCreadas).toHaveLength(1);
    expect(m.facturasCreadas[0]).toMatchObject({ codigoInmueble: '302' });
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
    expect(actualizacion.$set.estado).toBe('liquidado');
    expect(actualizacion.$set.resumen).toBeNull();
    // The orphaned invoice is still referenced — it exists, it just isn't
    // counted toward a completed resumen. Same "read the real generated id
    // back off the mock" reasoning as the test above.
    const idNuevaFactura = (
      m.facturasCreadas[0]._id as Types.ObjectId
    ).toString();
    expect(actualizacion.$set.facturaIds).toEqual(
      expect.arrayContaining(['fac-huerfana', idNuevaFactura]),
    );
  });

  const numeracionParaConsolidar = (completo = 'FV-1') =>
    ({
      siguienteLote: jest.fn().mockResolvedValue(1),
      reservarBloqueFacturas: jest.fn(
        (_coPropertyId: string, cantidad: number) =>
          Promise.resolve({
            numeros: Array.from({ length: cantidad }, (_, i) => ({
              prefijo: 'FV',
              numero: 1 + i,
              completo: i === 0 ? completo : `FV-${1 + i}`,
            })),
          }),
      ),
    }) as unknown as NumeracionService;

  const servicioConsolidar = (m: ReturnType<typeof construirModelos>) =>
    new LotesFacturacionService(
      m.lotes as never,
      m.facturas as never,
      m.saldos as never,
      m.carteraPorDocumento as never,
      m.saldoTotalDocumento as never,
      m.asientos as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      m.copropiedades as never,
      tenantQueDevuelve(COP),
      periodoAbierto(),
      numeracionParaConsolidar(),
      conexionCon(sesionFalsa()),
    );

  it('calcula y guarda el descuento por pronto pago en cada factura, a partir del % del lote', async () => {
    const m = construirModelos({
      lote: {
        descuentoProntoPago: 5,
        fechaLimiteDescuento: new Date('2026-08-10'),
      },
    });

    await servicioConsolidar(m).consolidar('lote-1');

    // 5% de 520000 (valorBase de Administración en `preliminar()`) = 26000.
    expect(m.facturasCreadas[0]).toMatchObject({
      montoDescuento: 26000,
      fechaLimiteDescuento: new Date('2026-08-10'),
    });
  });

  it('usa el valor fijo directo, sin calcular, cuando el lote no trae %', async () => {
    const m = construirModelos({
      lote: {
        descuentoProntoPago: 0,
        valorFijoDescuentoProntoPago: 15000,
        fechaLimiteDescuento: new Date('2026-08-10'),
      },
    });

    await servicioConsolidar(m).consolidar('lote-1');

    expect(m.facturasCreadas[0]).toMatchObject({
      montoDescuento: 15000,
      fechaLimiteDescuento: new Date('2026-08-10'),
    });
  });

  it('no ofrece descuento cuando la factura tiene mora y descuentoAplicaConMora está apagado', async () => {
    const m = construirModelos({
      lote: {
        descuentoProntoPago: 5,
        fechaLimiteDescuento: new Date('2026-08-10'),
      },
      copropiedad: {
        cuentaContableCartera: '130501',
        descuentoAplicaConMora: false,
      },
      previsualizacion: [
        preliminar({
          lineas: [
            ...preliminar().lineas,
            {
              conceptoId: 'con-2',
              nombreConcepto: 'Intereses de mora',
              tipoConcepto: 'intereses',
              cuentaIngreso: '413599',
              origen: 'interes',
              valorBase: 5000,
              tasaImpuesto: 0,
              valorImpuesto: 0,
              valorTotal: 5000,
            },
          ],
        }),
      ],
    });

    await servicioConsolidar(m).consolidar('lote-1');

    expect(m.facturasCreadas[0]).toMatchObject({
      montoDescuento: 0,
      fechaLimiteDescuento: null,
    });
  });

  it('SÍ ofrece descuento con mora cuando descuentoAplicaConMora está encendido', async () => {
    const m = construirModelos({
      lote: {
        descuentoProntoPago: 5,
        fechaLimiteDescuento: new Date('2026-08-10'),
      },
      copropiedad: {
        cuentaContableCartera: '130501',
        descuentoAplicaConMora: true,
      },
      previsualizacion: [
        preliminar({
          lineas: [
            ...preliminar().lineas,
            {
              conceptoId: 'con-2',
              nombreConcepto: 'Intereses de mora',
              tipoConcepto: 'intereses',
              cuentaIngreso: '413599',
              origen: 'interes',
              valorBase: 5000,
              tasaImpuesto: 0,
              valorImpuesto: 0,
              valorTotal: 5000,
            },
          ],
        }),
      ],
    });

    await servicioConsolidar(m).consolidar('lote-1');

    expect(m.facturasCreadas[0]).toMatchObject({
      montoDescuento: 26000,
      fechaLimiteDescuento: new Date('2026-08-10'),
    });
  });

  it('no ofrece descuento cuando el lote no tiene ni % ni valor fijo configurados', async () => {
    const m = construirModelos({
      lote: { descuentoProntoPago: 0, valorFijoDescuentoProntoPago: 0 },
    });

    await servicioConsolidar(m).consolidar('lote-1');

    expect(m.facturasCreadas[0]).toMatchObject({
      montoDescuento: 0,
      fechaLimiteDescuento: null,
    });
  });

  describe('todo o nada: un fallo deshace el lote y devuelve el consecutivo', () => {
    const RESOLUCION = new Types.ObjectId();

    type OpSaldo = {
      updateOne: {
        filter: Filtro;
        update: { $inc: { saldoPendiente: number } };
        upsert: boolean;
      };
    };
    const opsDe = (mock: jest.Mock): OpSaldo[] =>
      (mock.mock.calls as unknown as [OpSaldo[]][]).flatMap(([ops]) => ops);

    /** Model whose `find().session().lean().exec()` chain — what the cruce
     *  guard runs — resolves to `filas` (nothing references any Factura by
     *  default). */
    const cruceCon = (filas: Record<string, unknown>[] = []) => ({
      find: jest.fn((_filtro?: Filtro, _proyeccion?: Filtro) => ({
        session: () => ({
          lean: () => ({ exec: () => Promise.resolve(filas) }),
        }),
      })),
      // Pending lote-level PDF rows deleted by the undo.
      deleteMany: jest.fn((_filtro?: Filtro, _opciones?: Filtro) =>
        Promise.resolve({ deletedCount: 0 }),
      ),
    });

    /** Like `cruceCon`, but the rows depend on the filter (and the call
     *  number), so a per-Factura query and a lote-level one can be told
     *  apart. */
    const cruceSegun = (
      responder: (filtro: Filtro, llamada: number) => Record<string, unknown>[],
    ) => {
      let llamada = 0;
      return {
        deleteMany: jest.fn((_filtro?: Filtro, _opciones?: Filtro) =>
          Promise.resolve({ deletedCount: 0 }),
        ),
        find: jest.fn((filtro: Filtro, _proyeccion?: Filtro) => {
          llamada += 1;
          const n = llamada;
          return {
            session: () => ({
              lean: () => ({
                exec: () => Promise.resolve(responder(filtro, n)),
              }),
            }),
          };
        }),
      };
    };

    /** `true` for the guard's per-Factura query (`documentoId: { $in }`),
     *  `false` for the lote-level one (`documentoId: lote._id`). */
    const esPorFactura = (filtro: Filtro): boolean =>
      typeof filtro.documentoId === 'object' &&
      filtro.documentoId !== null &&
      '$in' in filtro.documentoId;

    /** `reservarBloqueFacturas` granting everything AND reporting the counter
     *  range, plus a `devolverContadorFacturas` spy. `antes` defaults to the
     *  first number (resolution semantics: next to issue). */
    const numeracionConContador = (opts: {
      prefijo: string;
      numero: number;
      resolucionId: Types.ObjectId | null;
      consecutivoId?: Types.ObjectId | null;
      antes?: number;
      devuelve?: boolean;
    }) => {
      const otorga = numeracionQueOtorgaTodo({
        prefijo: opts.prefijo,
        numero: opts.numero,
        ...(opts.resolucionId ? { resolucionId: opts.resolucionId } : {}),
      });
      const reservarBloqueFacturas = jest.fn(
        async (copropiedadId: string, cantidad: number) => ({
          ...(await otorga(copropiedadId, cantidad)),
          contador: {
            resolucionId: opts.resolucionId,
            consecutivoId: opts.consecutivoId ?? null,
            antes: opts.antes ?? opts.numero,
            despues: (opts.antes ?? opts.numero) + cantidad,
          },
        }),
      );
      const devolverContadorFacturas = jest.fn(
        (_copropiedadId: string, _contador: unknown) =>
          Promise.resolve(opts.devuelve ?? true),
      );
      const numeracion = {
        siguienteLote: jest.fn(),
        reservarBloqueFacturas,
        devolverContadorFacturas,
      } as unknown as NumeracionService;
      return { numeracion, reservarBloqueFacturas, devolverContadorFacturas };
    };

    const auditoriaFalsa = () => ({
      registrar: jest.fn((_entrada: Record<string, unknown>) =>
        Promise.resolve(),
      ),
    });

    const construirServicio = (
      m: ReturnType<typeof construirModelos>,
      numeracion: NumeracionService,
      extra: {
        aplicaciones?: unknown;
        notasCredito?: unknown;
        notasContables?: unknown;
        presentaciones?: unknown;
        auditoria?: unknown;
        publicaciones?: unknown;
      } = {},
    ) => {
      const startSession = jest.fn(() => Promise.resolve(sesionFalsa()));
      const service = new LotesFacturacionService(
        m.lotes as never,
        m.facturas as never,
        m.saldos as never,
        m.carteraPorDocumento as never,
        m.saldoTotalDocumento as never,
        m.asientos as never,
        {} as never, // conceptos
        {} as never, // valoresRecurrentes
        {} as never, // inmuebles
        {} as never, // terceros
        m.copropiedades as never,
        tenantQueDevuelve(COP),
        periodoAbierto(),
        numeracion,
        { startSession } as never,
        undefined, // cuentasContables
        undefined, // cola
        undefined, // eventosCola
        (extra.aplicaciones ?? cruceCon()) as never,
        (extra.notasCredito ?? cruceCon()) as never,
        (extra.notasContables ?? cruceCon()) as never,
        (extra.presentaciones ?? cruceCon()) as never,
        extra.auditoria as never,
        (extra.publicaciones ?? cruceCon()) as never,
      );
      return { service, startSession };
    };

    /** Facturas as `deshacerConsolidacion` reads them (lean). */
    const facturaLean = (n: number, over: Record<string, unknown> = {}) => ({
      _id: new Types.ObjectId(),
      inmuebleId: new Types.ObjectId(),
      numero: n,
      numeroCompleto: `CONJ-2026-${n}`,
      resolucionId: RESOLUCION,
      lineas: [
        { conceptoId: new Types.ObjectId(), valorTotal: 520000 },
        { conceptoId: new Types.ObjectId(), valorTotal: 30000 },
      ],
      ...over,
    });

    /** Makes `m.facturas.find` answer the resume lookup (`.exec()`) with
     *  `previas` and the undo's `.lean().exec()` with whatever `leidas()`
     *  returns at call time. */
    const facturasQueSeLeen = (
      m: ReturnType<typeof construirModelos>,
      leidas: () => Record<string, unknown>[],
      previas: Record<string, unknown>[] = [],
    ) => {
      m.facturas.find = jest.fn(() => ({
        exec: () => Promise.resolve(previas),
        lean: () => ({ exec: () => Promise.resolve(leidas()) }),
      })) as never;
    };

    const idsBorrados = (m: ReturnType<typeof construirModelos>): string[] =>
      (m.facturas.deleteMany.mock.calls as unknown as [Filtro][]).flatMap(
        ([filtro]) =>
          (filtro._id as { $in: Types.ObjectId[] }).$in.map((id) =>
            id.toString(),
          ),
      );

    const cienFilas = () =>
      Array.from({ length: 100 }, (_, i) =>
        preliminar({ inmuebleId: `inm-${i}`, codigoInmueble: String(i) }),
      );

    it('si una tanda falla: no lanza tandas nuevas, deshace las ya confirmadas y devuelve el contador a antes', async () => {
      const m = construirModelos({ previsualizacion: cienFilas() });
      const insertOriginal = m.facturas.insertMany;
      const insertMany = jest
        .fn()
        .mockRejectedValueOnce(new Error('Mongo se cayó'))
        .mockImplementation(insertOriginal);
      m.facturas.insertMany = insertMany as typeof m.facturas.insertMany;
      facturasQueSeLeen(m, () => m.facturasCreadas);
      const n = numeracionConContador({
        prefijo: 'CONJ-2026',
        numero: 1041,
        resolucionId: RESOLUCION,
      });
      const auditoria = auditoriaFalsa();
      const { service } = construirServicio(m, n.numeracion, { auditoria });

      const resultado = await service.consolidar('lote-1');

      // 100 filas = 5 tandas, 4 en paralelo: la primera falla antes de que
      // arranque la quinta, y esa quinta no debe lanzarse nunca.
      expect(insertMany).toHaveBeenCalledTimes(4);
      // Las 3 tandas que sí confirmaron (60 facturas) quedan deshechas.
      expect(m.facturasCreadas).toHaveLength(60);
      expect(idsBorrados(m).sort()).toEqual(
        m.facturasCreadas.map((f) => String(f._id)).sort(),
      );
      expect(m.facturas.deleteMany).toHaveBeenCalledTimes(3);
      expect(m.asientos.deleteMany).toHaveBeenCalledTimes(3);
      expect(m.carteraPorDocumento.deleteMany).toHaveBeenCalledTimes(3);
      expect(m.saldoTotalDocumento.deleteMany).toHaveBeenCalledTimes(3);
      // El contador vuelve a donde estaba antes de reservar.
      expect(n.devolverContadorFacturas).toHaveBeenCalledTimes(1);
      expect(n.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: RESOLUCION,
        consecutivoId: null,
        antes: 1041,
        despues: 1141,
      });
      // Se devuelven los errores originales (los de la tanda fallida) y el
      // lote queda liquidado, sin facturas ni resumen.
      expect(resultado.errores).toHaveLength(20);
      expect(resultado.errores[0].mensaje).toContain('Mongo se cayó');
      const actualizacion = actualizacionDe(m.lotes.findOneAndUpdate);
      expect(actualizacion.$set).toMatchObject({
        estado: 'liquidado',
        facturaIds: [],
        resumen: null,
      });
      // Queda registrada la reversión.
      expect(auditoria.registrar).toHaveBeenCalledTimes(1);
      expect(auditoria.registrar.mock.calls[0][0]).toMatchObject({
        accion: 'revertir',
        entidadTipo: 'lote-facturacion',
        entidadId: 'lote-1',
      });
      expect(auditoria.registrar.mock.calls[0][0].entidadEtiqueta).toContain(
        '60 facturas revertidas',
      );
    });

    it('con el consecutivo FV de respaldo devuelve el contador en su propia semántica (último emitido)', async () => {
      const m = construirModelos({
        previsualizacion: [
          preliminar(),
          preliminar({ inmuebleId: 'inm-2', codigoInmueble: '302' }),
        ],
      });
      m.asientos.insertMany = jest
        .fn()
        .mockRejectedValueOnce(
          new Error('Mongo se cayó'),
        ) as typeof m.asientos.insertMany;
      facturasQueSeLeen(m, () => []);
      // FV: antes = último emitido (10), los números otorgados son 11 y 12.
      const n = numeracionConContador({
        prefijo: 'FV',
        numero: 11,
        antes: 10,
        resolucionId: null,
        consecutivoId: CONSECUTIVO_FV,
      });
      const { service } = construirServicio(m, n.numeracion);

      await service.consolidar('lote-1');

      expect(n.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: null,
        consecutivoId: CONSECUTIVO_FV,
        antes: 10,
        despues: 12,
      });
    });

    it('si escapa una excepción (asiento desbalanceado): espera a las tandas en vuelo, deshace el lote y relanza el error original', async () => {
      const filas = Array.from({ length: 25 }, (_, i) =>
        i === 22
          ? preliminar({
              inmuebleId: 'inm-22',
              codigoInmueble: '22',
              lineas: [{ ...preliminar().lineas[0], valorTotal: NaN }],
            })
          : preliminar({ inmuebleId: `inm-${i}`, codigoInmueble: String(i) }),
      );
      const m = construirModelos({ previsualizacion: filas });
      facturasQueSeLeen(m, () => m.facturasCreadas);
      const n = numeracionConContador({
        prefijo: 'CONJ-2026',
        numero: 1041,
        resolucionId: RESOLUCION,
      });
      const { service } = construirServicio(m, n.numeracion);

      await expect(service.consolidar('lote-1')).rejects.toThrow(
        /desbalanceado/,
      );

      // La primera tanda (20 filas) alcanzó a confirmar y quedó deshecha.
      expect(m.facturasCreadas).toHaveLength(20);
      expect(idsBorrados(m)).toHaveLength(20);
      expect(n.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: RESOLUCION,
        consecutivoId: null,
        antes: 1041,
        despues: 1066,
      });
      // El lote queda sin facturas ni resumen en la base.
      const reinicio = m.lotes.updateOne.mock.calls.find(
        ([, act]) => 'facturaIds' in ((act as Filtro).$set as Filtro),
      );
      expect(reinicio?.[1]).toEqual({
        $set: {
          facturaIds: [],
          resumen: null,
          progreso: null,
          reclamoToken: null,
        },
      });
    });

    it('si la reversión falla tras una excepción, igual limpia el progreso y relanza el error original', async () => {
      const filas = Array.from({ length: 25 }, (_, i) =>
        i === 22
          ? preliminar({
              inmuebleId: 'inm-22',
              codigoInmueble: '22',
              lineas: [{ ...preliminar().lineas[0], valorTotal: NaN }],
            })
          : preliminar({ inmuebleId: `inm-${i}`, codigoInmueble: String(i) }),
      );
      const m = construirModelos({ previsualizacion: filas });
      facturasQueSeLeen(m, () => m.facturasCreadas);
      const n = numeracionConContador({
        prefijo: 'CONJ-2026',
        numero: 1041,
        resolucionId: RESOLUCION,
      });
      // The undo is refused (a payment hangs off a created Factura).
      const aplicaciones = cruceSegun(() =>
        m.facturasCreadas.slice(0, 1).map((f) => ({ documentoId: f._id })),
      );
      const { service } = construirServicio(m, n.numeracion, { aplicaciones });

      await expect(service.consolidar('lote-1')).rejects.toThrow(
        /desbalanceado/,
      );

      expect(m.facturas.deleteMany).not.toHaveBeenCalled();
      const limpieza = m.lotes.updateOne.mock.calls.find(
        ([, act]) =>
          JSON.stringify((act as Filtro).$set) ===
          JSON.stringify({ progreso: null, reclamoToken: null }),
      );
      // Released only if the token still owns the claim.
      expect(limpieza?.[0]).toEqual({
        _id: 'lote-1',
        copropiedadId: COP,
        reclamoToken: expect.any(String) as unknown,
      });
    });

    it('en un reintento tras un fallo, también deshace las facturas de una corrida anterior del mismo lote', async () => {
      const previo = facturaLean(900);
      const m = construirModelos({
        previsualizacion: [
          preliminar(),
          preliminar({ inmuebleId: 'inm-2', codigoInmueble: '302' }),
        ],
      });
      m.asientos.insertMany = jest
        .fn()
        .mockRejectedValueOnce(
          new Error('Mongo se cayó'),
        ) as typeof m.asientos.insertMany;
      m.facturas.find = jest.fn(() => ({
        exec: () => Promise.resolve([{ ...previo, inmuebleId: 'inm-0' }]),
        lean: () => ({ exec: () => Promise.resolve([previo]) }),
      })) as never;
      const n = numeracionConContador({
        prefijo: 'CONJ-2026',
        numero: 1041,
        resolucionId: RESOLUCION,
      });
      const { service } = construirServicio(m, n.numeracion);

      await service.consolidar('lote-1');

      expect(idsBorrados(m)).toEqual([previo._id.toString()]);
    });

    it('éxito total: cero llamadas extra — no deshace, no devuelve contador, no audita', async () => {
      const m = construirModelos({
        previsualizacion: [
          preliminar(),
          preliminar({ inmuebleId: 'inm-2', codigoInmueble: '302' }),
        ],
      });
      const n = numeracionConContador({
        prefijo: 'CONJ-2026',
        numero: 1041,
        resolucionId: RESOLUCION,
      });
      const auditoria = auditoriaFalsa();
      const aplicaciones = cruceCon();
      const { service, startSession } = construirServicio(m, n.numeracion, {
        auditoria,
        aplicaciones,
      });

      const resultado = await service.consolidar('lote-1');

      expect(resultado.errores).toEqual([]);
      expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
      expect(auditoria.registrar).not.toHaveBeenCalled();
      expect(aplicaciones.find).not.toHaveBeenCalled();
      expect(m.facturas.deleteMany).not.toHaveBeenCalled();
      expect(m.asientos.deleteMany).not.toHaveBeenCalled();
      // Una sola transacción (una tanda), la de la escritura normal.
      expect(startSession).toHaveBeenCalledTimes(1);
      // Una sola lectura de facturas: la del chequeo de reanudación.
      expect(m.facturas.find).toHaveBeenCalledTimes(1);
      expect(m.saldos.bulkWrite).toHaveBeenCalledTimes(1);
      expect(actualizacionDe(m.lotes.findOneAndUpdate).$set.estado).toBe(
        'consolidado',
      );
    });

    it('si el rango se agota (sin fallo de tanda) conserva el comportamiento de siempre: no deshace nada', async () => {
      const m = construirModelos({
        previsualizacion: [
          preliminar(),
          preliminar({ inmuebleId: 'inm-2', codigoInmueble: '302' }),
        ],
      });
      const n = numeracionConContador({
        prefijo: 'CONJ-2026',
        numero: 1041,
        resolucionId: RESOLUCION,
      });
      // Otorga solo 1 de las 2 pedidas.
      n.reservarBloqueFacturas.mockImplementation((_c: string, _q: number) =>
        Promise.resolve({
          numeros: [
            {
              prefijo: 'CONJ-2026',
              numero: 1041,
              completo: 'CONJ-2026-1041',
              resolucionId: RESOLUCION,
            },
          ],
          contador: {
            resolucionId: RESOLUCION,
            consecutivoId: null,
            antes: 1041,
            despues: 1042,
          },
        }),
      );
      const { service } = construirServicio(m, n.numeracion);

      const resultado = await service.consolidar('lote-1');

      expect(resultado.errores).toHaveLength(1);
      expect(m.facturas.deleteMany).not.toHaveBeenCalled();
      expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
    });

    describe('deshacerConsolidacion', () => {
      it('resta exactamente los mismos $inc que consolidar sumó, por (inmueble, concepto), sin upsert', async () => {
        const m = construirModelos({});
        const f1 = facturaLean(1041);
        const f2 = facturaLean(1042);
        facturasQueSeLeen(m, () => [f1, f2]);
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
        });
        const { service } = construirServicio(m, n.numeracion);

        await service.deshacerConsolidacion(
          loteDoc({ estado: 'liquidado' }) as never,
          COP,
          null,
        );

        const ops = opsDe(m.saldos.bulkWrite);
        const lineas = [f1, f2].flatMap((f) =>
          (
            f.lineas as { conceptoId: Types.ObjectId; valorTotal: number }[]
          ).map((l) => ({ f, l })),
        );
        expect(ops).toEqual(
          lineas.map(({ f, l }) => ({
            updateOne: {
              filter: {
                copropiedadId: COP,
                inmuebleId: f.inmuebleId,
                conceptoId: l.conceptoId,
              },
              update: { $inc: { saldoPendiente: -l.valorTotal } },
              upsert: false,
            },
          })),
        );
      });

      it('procesa en bloques de 20, una transacción por bloque', async () => {
        const m = construirModelos({});
        const facturas = Array.from({ length: 45 }, (_, i) =>
          facturaLean(1000 + i),
        );
        facturasQueSeLeen(m, () => facturas);
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1000,
          resolucionId: RESOLUCION,
        });
        const { service, startSession } = construirServicio(m, n.numeracion);

        const r = await service.deshacerConsolidacion(
          loteDoc() as never,
          COP,
          null,
        );

        expect(r.facturasRevertidas).toBe(45);
        expect(startSession).toHaveBeenCalledTimes(3); // 20 + 20 + 5
        expect(m.facturas.deleteMany).toHaveBeenCalledTimes(3);
      });

      it('la guarda de cruces aborta TODO sin borrar nada cuando una factura tiene una aplicación', async () => {
        const m = construirModelos({});
        const facturas = [facturaLean(1041), facturaLean(1042)];
        facturasQueSeLeen(m, () => facturas);
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
        });
        const aplicaciones = cruceCon([{ documentoId: facturas[1]._id }]);
        const auditoria = auditoriaFalsa();
        const { service, startSession } = construirServicio(m, n.numeracion, {
          aplicaciones,
          auditoria,
        });

        const intento = service.deshacerConsolidacion(loteDoc() as never, COP, {
          resolucionId: RESOLUCION,
          consecutivoId: null,
          antes: 1041,
          despues: 1043,
        });

        await expect(intento).rejects.toBeInstanceOf(ConflictException);
        await expect(intento).rejects.toThrow(/CONJ-2026-1042/);
        await expect(intento).rejects.toThrow(/No se eliminó nada/);
        expect(startSession).not.toHaveBeenCalled();
        expect(m.saldos.bulkWrite).not.toHaveBeenCalled();
        expect(m.facturas.deleteMany).not.toHaveBeenCalled();
        expect(m.asientos.deleteMany).not.toHaveBeenCalled();
        expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
        expect(auditoria.registrar).not.toHaveBeenCalled();
      });

      it.each([
        ['una nota crédito', 'notasCredito', 'facturaId'],
        ['una nota contable', 'notasContables', 'documentoId'],
        ['un PDF ya generado', 'presentaciones', 'documentoId'],
      ])(
        'la guarda también bloquea cuando la factura tiene %s',
        async (_nombre, modelo, campo) => {
          const m = construirModelos({});
          const facturas = [facturaLean(1041)];
          facturasQueSeLeen(m, () => facturas);
          const n = numeracionConContador({
            prefijo: 'CONJ-2026',
            numero: 1041,
            resolucionId: RESOLUCION,
          });
          // Only the per-Factura query matches (the lote-level PDF query,
          // also on `presentaciones`, finds nothing), so this exercises
          // exactly the per-Factura branch.
          const cruce = cruceSegun((filtro) =>
            modelo === 'presentaciones' && !esPorFactura(filtro)
              ? []
              : [{ [campo]: facturas[0]._id }],
          );
          const { service, startSession } = construirServicio(m, n.numeracion, {
            [modelo]: cruce,
          });
          const intento = service.deshacerConsolidacion(
            loteDoc() as never,
            COP,
            null,
          );

          await expect(intento).rejects.toBeInstanceOf(ConflictException);
          await expect(intento).rejects.toThrow(/CONJ-2026-1041/);
          expect(cruce.find).toHaveBeenCalled();
          expect(startSession).not.toHaveBeenCalled();
          expect(m.saldos.bulkWrite).not.toHaveBeenCalled();
          expect(m.facturas.deleteMany).not.toHaveBeenCalled();
          expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
        },
      );

      describe('artefactos a nivel de lote', () => {
        const caso = (
          nombre: string,
          armar: (facturas: ReturnType<typeof facturaLean>[]) => {
            facturas: ReturnType<typeof facturaLean>[];
            extra: Record<string, unknown>;
          },
          mensaje: RegExp,
        ) =>
          it(nombre, async () => {
            const m = construirModelos({});
            const { facturas, extra } = armar([facturaLean(1041)]);
            facturasQueSeLeen(m, () => facturas);
            const n = numeracionConContador({
              prefijo: 'CONJ-2026',
              numero: 1041,
              resolucionId: RESOLUCION,
            });
            const auditoria = auditoriaFalsa();
            const { service, startSession } = construirServicio(
              m,
              n.numeracion,
              { ...extra, auditoria },
            );
            const intento = service.deshacerConsolidacion(
              loteDoc() as never,
              COP,
              {
                resolucionId: RESOLUCION,
                consecutivoId: null,
                antes: 1041,
                despues: 1042,
              },
            );

            await expect(intento).rejects.toBeInstanceOf(ConflictException);
            await expect(intento).rejects.toThrow(mensaje);
            await expect(intento).rejects.toThrow(/No se eliminó nada/);
            expect(startSession).not.toHaveBeenCalled();
            expect(m.saldos.bulkWrite).not.toHaveBeenCalled();
            expect(m.facturas.deleteMany).not.toHaveBeenCalled();
            expect(m.asientos.deleteMany).not.toHaveBeenCalled();
            expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
            expect(auditoria.registrar).not.toHaveBeenCalled();
          });

        caso(
          'bloquea cuando el lote ya tiene el PDF de facturas generado (PresentacionDocumento anclada al lote)',
          (facturas) => ({
            facturas,
            extra: {
              presentaciones: cruceSegun((filtro) =>
                esPorFactura(filtro) ? [] : [{ documentoId: 'lote-1' }],
              ),
            },
          }),
          /PDF de sus facturas generado/,
        );

        caso(
          'bloquea cuando el lote ya tiene una fila de publicación (PublicacionLote)',
          (facturas) => ({
            facturas,
            extra: { publicaciones: cruceCon([{ loteId: 'lote-1' }]) },
          }),
          /encolado o publicado a WebSaco3/,
        );

        caso(
          'bloquea cuando alguna factura del lote ya tiene printSnapshot',
          () => ({
            facturas: [
              facturaLean(1041, { printSnapshot: { docDefinition: 1 } }),
            ],
            extra: {},
          }),
          /representación impresa congelada/,
        );

        it('falla cerrado: sin el modelo de publicaciones se niega a borrar', async () => {
          const m = construirModelos({});
          facturasQueSeLeen(m, () => [facturaLean(1041)]);
          const n = numeracionConContador({
            prefijo: 'CONJ-2026',
            numero: 1041,
            resolucionId: RESOLUCION,
          });
          const service = new LotesFacturacionService(
            m.lotes as never,
            m.facturas as never,
            m.saldos as never,
            m.carteraPorDocumento as never,
            m.saldoTotalDocumento as never,
            m.asientos as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
            m.copropiedades as never,
            tenantQueDevuelve(COP),
            periodoAbierto(),
            n.numeracion,
            conexionCon(sesionFalsa()),
            undefined,
            undefined,
            undefined,
            cruceCon() as never,
            cruceCon() as never,
            cruceCon() as never,
            cruceCon() as never,
            undefined,
            undefined, // publicacionesLote
          );

          await expect(
            service.deshacerConsolidacion(loteDoc() as never, COP, null),
          ).rejects.toThrow(/guarda de seguridad/);
          expect(m.facturas.deleteMany).not.toHaveBeenCalled();
        });

        it('la re-verificación dentro de la transacción también lo detecta (publicado entre la pre-pasada y el bloque): no escribe nada', async () => {
          const m = construirModelos({});
          const facturas = [facturaLean(1041)];
          facturasQueSeLeen(m, () => facturas);
          const n = numeracionConContador({
            prefijo: 'CONJ-2026',
            numero: 1041,
            resolucionId: RESOLUCION,
          });
          // 1ª consulta (pre-pasada): nada; 2ª (dentro del bloque): publicado.
          const publicaciones = cruceSegun((_f, llamada) =>
            llamada === 1 ? [] : [{ loteId: 'lote-1' }],
          );
          const { service, startSession } = construirServicio(m, n.numeracion, {
            publicaciones,
          });
          const intento = service.deshacerConsolidacion(
            loteDoc() as never,
            COP,
            null,
          );

          await expect(intento).rejects.toBeInstanceOf(ConflictException);
          await expect(intento).rejects.toThrow(/quedó incompleta/);
          expect(startSession).toHaveBeenCalledTimes(1);
          expect(m.saldos.bulkWrite).not.toHaveBeenCalled();
          expect(m.facturas.deleteMany).not.toHaveBeenCalled();
          // Nothing was deleted, so facturaIds is not touched either.
          expect(m.lotes.updateOne).not.toHaveBeenCalled();
        });
      });

      it('rechaza deshacer con una factura huérfana (sin asiento): pide conciliación manual y no escribe nada', async () => {
        const m = construirModelos({});
        const facturas = [facturaLean(1041), facturaLean(1042)];
        facturasQueSeLeen(m, () => facturas);
        // Only the first Factura has its asiento.
        m.asientos.find = jest.fn(() => ({
          exec: () => Promise.resolve([]),
          lean: () => ({
            exec: () => Promise.resolve([{ facturaId: facturas[0]._id }]),
          }),
        })) as never;
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
        });
        const auditoria = auditoriaFalsa();
        const { service, startSession } = construirServicio(m, n.numeracion, {
          auditoria,
        });
        const intento = service.deshacerConsolidacion(loteDoc() as never, COP, {
          resolucionId: RESOLUCION,
          consecutivoId: null,
          antes: 1041,
          despues: 1043,
        });

        await expect(intento).rejects.toBeInstanceOf(ConflictException);
        await expect(intento).rejects.toThrow(/CONJ-2026-1042/);
        await expect(intento).rejects.toThrow(/conciliación manual/);
        expect(startSession).not.toHaveBeenCalled();
        expect(m.saldos.bulkWrite).not.toHaveBeenCalled();
        expect(m.facturas.deleteMany).not.toHaveBeenCalled();
        expect(m.asientos.deleteMany).not.toHaveBeenCalled();
        expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
        expect(auditoria.registrar).not.toHaveBeenCalled();
      });

      it('si un bloque posterior falla tras borrar los anteriores, persiste facturaIds con las facturas restantes y no devuelve el contador', async () => {
        const m = construirModelos({});
        const facturas = Array.from({ length: 45 }, (_, i) =>
          facturaLean(1000 + i),
        );
        let existentes = facturas;
        facturasQueSeLeen(m, () => existentes);
        m.facturas.deleteMany = jest.fn((filtro: Filtro) => {
          const borrar = new Set(
            (filtro._id as { $in: Types.ObjectId[] }).$in.map(String),
          );
          existentes = existentes.filter((f) => !borrar.has(String(f._id)));
          return Promise.resolve({ deletedCount: borrar.size });
        }) as never;
        // 2nd block's saldos write fails; the 1st block already committed.
        m.saldos.bulkWrite = jest
          .fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('Mongo se cayó')) as never;
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1000,
          resolucionId: RESOLUCION,
        });
        const { service } = construirServicio(m, n.numeracion);

        await expect(
          service.deshacerConsolidacion(loteDoc() as never, COP, {
            resolucionId: RESOLUCION,
            consecutivoId: null,
            antes: 1000,
            despues: 1045,
          }),
        ).rejects.toThrow('Mongo se cayó');

        expect(existentes).toHaveLength(25);
        const escritura = m.lotes.updateOne.mock.calls.find(
          ([, act]) => 'facturaIds' in ((act as Filtro).$set as Filtro),
        );
        expect(escritura?.[0]).toEqual({ _id: 'lote-1', copropiedadId: COP });
        expect(escritura?.[1]).toEqual({
          $set: { facturaIds: existentes.map((f) => f._id) },
        });
        expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
      });

      it('falla cerrado: sin los modelos de la guarda se niega a borrar', async () => {
        const m = construirModelos({});
        facturasQueSeLeen(m, () => [facturaLean(1041)]);
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
        });
        const service = new LotesFacturacionService(
          m.lotes as never,
          m.facturas as never,
          m.saldos as never,
          m.carteraPorDocumento as never,
          m.saldoTotalDocumento as never,
          m.asientos as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          m.copropiedades as never,
          tenantQueDevuelve(COP),
          periodoAbierto(),
          n.numeracion,
          conexionCon(sesionFalsa()),
        );

        await expect(
          service.deshacerConsolidacion(loteDoc() as never, COP, null),
        ).rejects.toThrow(/guarda de seguridad/);
        expect(m.facturas.deleteMany).not.toHaveBeenCalled();
      });

      it('es idempotente: repetirlo solo encuentra las facturas que aún existen y no resta dos veces', async () => {
        const m = construirModelos({});
        const facturas = [facturaLean(1041), facturaLean(1042)];
        let existentes = facturas;
        facturasQueSeLeen(m, () => existentes);
        m.facturas.deleteMany = jest.fn(() => {
          existentes = [];
          return Promise.resolve({ deletedCount: 2 });
        }) as never;
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
          devuelve: false,
        });
        const { service } = construirServicio(m, n.numeracion);
        const contador = {
          resolucionId: RESOLUCION,
          consecutivoId: null,
          antes: 1041,
          despues: 1043,
        };

        await service.deshacerConsolidacion(loteDoc() as never, COP, contador);
        const opsTrasPrimera = opsDe(m.saldos.bulkWrite);
        const segunda = await service.deshacerConsolidacion(
          loteDoc() as never,
          COP,
          contador,
        );

        expect(segunda.facturasRevertidas).toBe(0);
        expect(opsDe(m.saldos.bulkWrite as unknown as jest.Mock)).toEqual(
          opsTrasPrimera,
        );
      });

      it('si otro movió el contador no lo toca y lo informa en el resultado y en la auditoría', async () => {
        const m = construirModelos({});
        facturasQueSeLeen(m, () => [facturaLean(1041)]);
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
          devuelve: false,
        });
        const auditoria = auditoriaFalsa();
        const { service } = construirServicio(m, n.numeracion, { auditoria });

        const r = await service.deshacerConsolidacion(loteDoc() as never, COP, {
          resolucionId: RESOLUCION,
          consecutivoId: null,
          antes: 1041,
          despues: 1042,
        });

        expect(r.contadorDevuelto).toBe(false);
        expect(r.auditoriaRegistrada).toBe(true);
        expect(auditoria.registrar.mock.calls[0][0].entidadEtiqueta).toContain(
          'consecutivo NO devuelto',
        );
      });

      it('un fallo al escribir la auditoría no enmascara la reversión ya hecha', async () => {
        const m = construirModelos({});
        facturasQueSeLeen(m, () => [facturaLean(1041)]);
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
        });
        const auditoria = {
          registrar: jest.fn(() =>
            Promise.reject(new Error('auditoría caída')),
          ),
        };
        const { service } = construirServicio(m, n.numeracion, { auditoria });

        const r = await service.deshacerConsolidacion(
          loteDoc() as never,
          COP,
          null,
        );

        expect(r.facturasRevertidas).toBe(1);
        expect(r.auditoriaRegistrada).toBe(false);
      });
    });

    describe('reclamo de la corrida (R1)', () => {
      const unaFila = () => construirModelos({});
      const numeracionSimple = () =>
        numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
        });
      type LlamadaLote = [Filtro, { $set: Record<string, unknown> }];
      const llamadasFindOneAndUpdate = (
        m: ReturnType<typeof construirModelos>,
      ) => m.lotes.findOneAndUpdate.mock.calls as unknown as LlamadaLote[];
      const llamadasUpdateOne = (m: ReturnType<typeof construirModelos>) =>
        m.lotes.updateOne.mock.calls as unknown as LlamadaLote[];
      const sinResultado = () => ({ exec: () => Promise.resolve(null) });

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('reclama el lote con UN findOneAndUpdate condicionado a que no haya otra corrida (progreso nulo o vencido)', async () => {
        const ahora = new Date('2026-09-01T12:00:00Z').getTime();
        jest.spyOn(Date, 'now').mockReturnValue(ahora);
        const m = unaFila();
        const { service } = construirServicio(m, numeracionSimple().numeracion);

        await service.consolidar('lote-1');

        const [filtro, actualizacion] = llamadasFindOneAndUpdate(m)[0];
        expect(filtro).toEqual({
          _id: 'lote-1',
          copropiedadId: COP,
          estado: 'liquidado',
          $or: [
            { progreso: null },
            { updatedAt: { $lt: new Date(ahora - 15 * 60 * 1000) } },
          ],
        });
        expect(actualizacion).toEqual({
          $set: {
            progreso: { actual: 0, total: 0 },
            reclamoToken: expect.any(String) as unknown,
          },
        });
        // Camino feliz: el reclamo + la escritura final, nada más.
        expect(m.lotes.findOneAndUpdate).toHaveBeenCalledTimes(2);
      });

      it('una segunda corrida concurrente se rechaza sin reservar números ni escribir nada', async () => {
        const m = unaFila();
        m.lotes.findOneAndUpdate = jest.fn(
          sinResultado,
        ) as unknown as typeof m.lotes.findOneAndUpdate;
        const n = numeracionSimple();
        const { service } = construirServicio(m, n.numeracion);

        const intento = service.consolidar('lote-1');

        await expect(intento).rejects.toBeInstanceOf(ConflictException);
        await expect(intento).rejects.toThrow(/en curso/);
        expect(n.reservarBloqueFacturas).not.toHaveBeenCalled();
        expect(m.facturas.insertMany).not.toHaveBeenCalled();
        // No libera el reclamo de la OTRA corrida.
        expect(m.lotes.updateOne).not.toHaveBeenCalled();
      });

      it('un reclamo vencido (más de 15 minutos sin escribir) se puede retomar: el filtro lo admite y la corrida sigue', async () => {
        const ahora = new Date('2026-09-01T12:00:00Z').getTime();
        jest.spyOn(Date, 'now').mockReturnValue(ahora);
        const m = unaFila();
        const { service } = construirServicio(m, numeracionSimple().numeracion);

        const resultado = await service.consolidar('lote-1');

        const { $or } = llamadasFindOneAndUpdate(m)[0][0] as {
          $or: Filtro[];
        };
        expect($or[1]).toEqual({
          updatedAt: { $lt: new Date('2026-09-01T11:45:00Z') },
        });
        expect(resultado.errores).toEqual([]);
        expect(m.facturasCreadas).toHaveLength(1);
      });

      it('libera el reclamo al terminar bien: la escritura final deja progreso en null', async () => {
        const m = unaFila();
        const { service } = construirServicio(m, numeracionSimple().numeracion);

        await service.consolidar('lote-1');

        const llamadas = llamadasFindOneAndUpdate(m);
        const final = llamadas[llamadas.length - 1];
        expect(final[1].$set.progreso).toBeNull();
        expect(final[1].$set.reclamoToken).toBeNull();
      });

      it('libera el reclamo si una tanda falla: lote liquidado y progreso en null', async () => {
        const m = unaFila();
        m.asientos.insertMany = jest
          .fn()
          .mockRejectedValueOnce(
            new Error('Mongo se cayó'),
          ) as typeof m.asientos.insertMany;
        facturasQueSeLeen(m, () => []);
        const { service } = construirServicio(m, numeracionSimple().numeracion);

        await service.consolidar('lote-1');

        const llamadas = llamadasFindOneAndUpdate(m);
        expect(llamadas[llamadas.length - 1][1].$set).toMatchObject({
          estado: 'liquidado',
          progreso: null,
        });
      });

      it('libera el reclamo si escapa una excepción durante la corrida', async () => {
        const m = construirModelos({
          previsualizacion: [
            preliminar({
              lineas: [{ ...preliminar().lineas[0], valorTotal: NaN }],
            }),
          ],
        });
        facturasQueSeLeen(m, () => m.facturasCreadas);
        const { service } = construirServicio(m, numeracionSimple().numeracion);

        await expect(service.consolidar('lote-1')).rejects.toThrow();

        const escrituras = llamadasUpdateOne(m);
        // Whether the undo cleaned the lote or only released the claim, the
        // last write always ends the claim (progreso AND token).
        expect(escrituras[escrituras.length - 1][1].$set).toMatchObject({
          progreso: null,
          reclamoToken: null,
        });
      });

      it('libera el reclamo si algo falla ANTES de reservar números (p. ej. al leer la copropiedad)', async () => {
        const m = unaFila();
        m.copropiedades.findById = jest.fn(() => ({
          exec: () => Promise.reject(new Error('copropiedades caída')),
        }));
        const n = numeracionSimple();
        const { service } = construirServicio(m, n.numeracion);

        await expect(service.consolidar('lote-1')).rejects.toThrow(
          'copropiedades caída',
        );

        expect(n.reservarBloqueFacturas).not.toHaveBeenCalled();
        expect(llamadasUpdateOne(m)).toEqual([
          [
            {
              _id: 'lote-1',
              copropiedadId: COP,
              reclamoToken: expect.any(String) as unknown,
            },
            { $set: { progreso: null, reclamoToken: null } },
          ],
        ]);
      });

      it('si la corrida perdió su reclamo (la escritura final no coincide): no sobrescribe, no deshace nada y lanza Conflict', async () => {
        const m = unaFila();
        m.lotes.findOneAndUpdate = jest
          .fn()
          .mockReturnValueOnce({
            exec: () => Promise.resolve(loteDoc({ estado: 'liquidado' })),
          })
          .mockReturnValueOnce(sinResultado()) as never;
        facturasQueSeLeen(m, () => [facturaLean(1041)]);
        const n = numeracionSimple();
        const { service } = construirServicio(m, n.numeracion);

        const intento = service.consolidar('lote-1');

        await expect(intento).rejects.toBeInstanceOf(ConflictException);
        await expect(intento).rejects.toThrow(/perdió el reclamo del lote/);
        // La otra corrida es la dueña: ni se deshace ni se libera lo suyo.
        expect(m.facturas.deleteMany).not.toHaveBeenCalled();
        expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
        expect(
          llamadasUpdateOne(m).filter(
            ([, act]) =>
              'reclamoToken' in act.$set && act.$set.progreso === null,
          ),
        ).toEqual([]);
      });

      describe('token de dueño del reclamo (W3)', () => {
        const tokenDelReclamo = (m: ReturnType<typeof construirModelos>) =>
          llamadasFindOneAndUpdate(m)[0][1].$set.reclamoToken as string;

        it('el reclamo sella un UUID nuevo y la escritura final queda condicionada a ese token y lo borra junto con progreso', async () => {
          const m = unaFila();
          const { service } = construirServicio(
            m,
            numeracionSimple().numeracion,
          );

          await service.consolidar('lote-1');

          const token = tokenDelReclamo(m);
          expect(token).toMatch(/^[0-9a-f-]{36}$/);
          const llamadas = llamadasFindOneAndUpdate(m);
          const [filtroFinal, actFinal] = llamadas[llamadas.length - 1];
          expect(filtroFinal).toEqual({
            _id: 'lote-1',
            copropiedadId: COP,
            reclamoToken: token,
          });
          expect(actFinal.$set).toMatchObject({
            progreso: null,
            reclamoToken: null,
          });
        });

        it('dos corridas distintas reciben tokens distintos', async () => {
          const m1 = unaFila();
          const m2 = unaFila();
          await construirServicio(
            m1,
            numeracionSimple().numeracion,
          ).service.consolidar('lote-1');
          await construirServicio(
            m2,
            numeracionSimple().numeracion,
          ).service.consolidar('lote-1');

          expect(tokenDelReclamo(m1)).not.toEqual(tokenDelReclamo(m2));
        });

        it('las escrituras de progreso van condicionadas al token', async () => {
          const m = unaFila();
          const { service } = construirServicio(
            m,
            numeracionSimple().numeracion,
          );

          await service.consolidar('lote-1');

          const progresos = llamadasUpdateOne(m).filter(
            ([, act]) => 'progreso' in act.$set,
          );
          expect(progresos.length).toBeGreaterThan(0);
          for (const [filtro] of progresos) {
            expect(filtro).toEqual({
              _id: 'lote-1',
              copropiedadId: COP,
              reclamoToken: tokenDelReclamo(m),
            });
          }
        });

        it('si una escritura de progreso no coincide (otra corrida tomó el lote): corta con Conflict sin deshacer ni liberar lo ajeno', async () => {
          const m = unaFila();
          m.lotes.updateOne = jest.fn(
            (_filtro?: Filtro, _actualizacion?: Filtro) => ({
              exec: () => Promise.resolve({ matchedCount: 0 }),
            }),
          );
          facturasQueSeLeen(m, () => m.facturasCreadas);
          const n = numeracionSimple();
          const { service } = construirServicio(m, n.numeracion);

          await expect(service.consolidar('lote-1')).rejects.toThrow(
            /perdió el reclamo del lote/,
          );

          expect(m.facturas.deleteMany).not.toHaveBeenCalled();
          expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
          // Solo el intento de progreso: ninguna liberación del reclamo ajeno.
          expect(m.lotes.updateOne).toHaveBeenCalledTimes(1);
        });

        it('si tras una excepción el latido previo al undo revela que el reclamo se perdió: no deshace y relanza el error original', async () => {
          const m = construirModelos({
            previsualizacion: [
              preliminar({
                lineas: [{ ...preliminar().lineas[0], valorTotal: NaN }],
              }),
            ],
          });
          m.lotes.updateOne = jest.fn(
            (_filtro?: Filtro, actualizacion?: Filtro) => ({
              exec: () =>
                Promise.resolve(
                  'updatedAt' in ((actualizacion?.$set ?? {}) as Filtro)
                    ? { matchedCount: 0 }
                    : {},
                ),
            }),
          );
          facturasQueSeLeen(m, () => m.facturasCreadas);
          const n = numeracionSimple();
          const { service } = construirServicio(m, n.numeracion);

          await expect(service.consolidar('lote-1')).rejects.toThrow(
            /desbalanceado/,
          );

          expect(m.facturas.deleteMany).not.toHaveBeenCalled();
          expect(n.devolverContadorFacturas).not.toHaveBeenCalled();
        });
      });

      describe('latido del reclamo (S4)', () => {
        const conLatido = (m: ReturnType<typeof construirModelos>) =>
          llamadasUpdateOne(m).filter(([, act]) => 'updatedAt' in act.$set);

        it('una corrida corta (menos de 60 s) no hace ninguna llamada extra', async () => {
          const ahora = new Date('2026-09-01T12:00:00Z').getTime();
          jest.spyOn(Date, 'now').mockReturnValue(ahora);
          const m = construirModelos({
            previsualizacion: Array.from({ length: 50 }, (_, i) =>
              preliminar({ inmuebleId: `inm-${i}`, codigoInmueble: `${i}` }),
            ),
          });
          const { service } = construirServicio(
            m,
            numeracionSimple().numeracion,
          );

          await service.consolidar('lote-1');

          expect(conLatido(m)).toEqual([]);
          // Solo escrituras de progreso, como antes.
          expect(
            llamadasUpdateOne(m).every(([, act]) => 'progreso' in act.$set),
          ).toBe(true);
        });

        it('pasados más de 60 s sin escribir, al completar una tanda hace UN latido condicionado al token', async () => {
          let reloj = new Date('2026-09-01T12:00:00Z').getTime();
          jest.spyOn(Date, 'now').mockImplementation(() => reloj);
          // 50 filas: 3 tandas (20/20/10) y progreso cada 3 filas, así que
          // las dos primeras tandas NO coinciden con una escritura de
          // progreso y solo las cubre el latido.
          const m = construirModelos({
            previsualizacion: Array.from({ length: 50 }, (_, i) =>
              preliminar({ inmuebleId: `inm-${i}`, codigoInmueble: `${i}` }),
            ),
          });
          const insertOriginal = m.facturas.insertMany;
          let primera = true;
          m.facturas.insertMany = jest.fn((docs: Record<string, unknown>[]) => {
            if (primera) {
              primera = false;
              reloj += 70_000;
            }
            return insertOriginal(docs);
          }) as typeof m.facturas.insertMany;
          const { service } = construirServicio(
            m,
            numeracionSimple().numeracion,
          );

          await service.consolidar('lote-1');

          const latidos = conLatido(m);
          expect(latidos).toHaveLength(1);
          expect(latidos[0][0]).toEqual({
            _id: 'lote-1',
            copropiedadId: COP,
            reclamoToken: llamadasFindOneAndUpdate(m)[0][1].$set.reclamoToken,
          });
        });

        it('tras una excepción, toca el latido ANTES de empezar el undo', async () => {
          const m = construirModelos({
            previsualizacion: [
              preliminar({
                lineas: [{ ...preliminar().lineas[0], valorTotal: NaN }],
              }),
            ],
          });
          facturasQueSeLeen(m, () => [facturaLean(1041)]);
          const { service } = construirServicio(
            m,
            numeracionSimple().numeracion,
          );

          await expect(service.consolidar('lote-1')).rejects.toThrow();

          expect(conLatido(m)).toHaveLength(1);
          const idxLatido = llamadasUpdateOne(m).findIndex(
            ([, act]) => 'updatedAt' in act.$set,
          );
          expect(
            m.lotes.updateOne.mock.invocationCallOrder[idxLatido],
          ).toBeLessThan(m.facturas.deleteMany.mock.invocationCallOrder[0]);
        });

        it('si una tanda falla, toca el latido ANTES de deshacer', async () => {
          const m = unaFila();
          m.asientos.insertMany = jest
            .fn()
            .mockRejectedValueOnce(
              new Error('Mongo se cayó'),
            ) as typeof m.asientos.insertMany;
          facturasQueSeLeen(m, () => [facturaLean(1041)]);
          const { service } = construirServicio(
            m,
            numeracionSimple().numeracion,
          );

          await service.consolidar('lote-1');

          expect(conLatido(m)).toHaveLength(1);
          const idxLatido = llamadasUpdateOne(m).findIndex(
            ([, act]) => 'updatedAt' in act.$set,
          );
          expect(
            m.lotes.updateOne.mock.invocationCallOrder[idxLatido],
          ).toBeLessThan(m.facturas.deleteMany.mock.invocationCallOrder[0]);
        });
      });
    });

    describe('auditoría de la reversión: quién y qué (R4)', () => {
      const copropiedad = {
        cuentaContableCartera: '130501',
        codigo: 'CONJ-01',
        nombre: 'Conjunto Los Pinos',
      };
      const corridaFallida = async (actor?: typeof ACTOR) => {
        const m = construirModelos({ copropiedad });
        m.asientos.insertMany = jest
          .fn()
          .mockRejectedValueOnce(
            new Error('Mongo se cayó'),
          ) as typeof m.asientos.insertMany;
        facturasQueSeLeen(m, () => [facturaLean(1041)]);
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
        });
        const auditoria = auditoriaFalsa();
        const { service } = construirServicio(m, n.numeracion, { auditoria });
        await service.consolidar('lote-1', actor);
        return auditoria.registrar.mock.calls[0][0];
      };

      it('una consolidación fallida registra a quien la lanzó, con copropiedad, número de lote y motivo', async () => {
        const entrada = await corridaFallida(ACTOR);

        expect(entrada).toMatchObject({
          actorAccountId: 'cuenta-actora',
          actorNombre: 'Ana Actora',
          accion: 'revertir',
          entidadTipo: 'lote-facturacion',
        });
        expect(entrada.entidadEtiqueta).toContain('CONJ-01 Conjunto Los Pinos');
        expect(entrada.entidadEtiqueta).toContain('Lote 1');
        expect(entrada.entidadEtiqueta).toContain(
          'reversión por consolidación fallida',
        );
      });

      it('sin actor en el trabajo cae al generadoPor del lote como "Sistema"', async () => {
        const entrada = await corridaFallida(undefined);

        expect(entrada).toMatchObject({
          actorAccountId: CUENTA,
          actorNombre: 'Sistema',
        });
      });

      it('con la cola, consolidar() mete al actor en los datos del trabajo', async () => {
        const m = construirModelos({});
        const trabajo = {
          waitUntilFinished: jest
            .fn()
            .mockResolvedValue({ lote: {}, errores: [] }),
        };
        const cola = { add: jest.fn().mockResolvedValue(trabajo) };
        const service = new LotesFacturacionService(
          m.lotes as never,
          m.facturas as never,
          m.saldos as never,
          m.carteraPorDocumento as never,
          m.saldoTotalDocumento as never,
          m.asientos as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          m.copropiedades as never,
          tenantQueDevuelve(COP),
          periodoAbierto(),
          {} as never,
          {} as never,
          undefined,
          cola as never,
          {} as never,
        );

        await service.consolidar('lote-1', ACTOR);

        expect(cola.add).toHaveBeenCalledWith(expect.any(String), {
          loteId: 'lote-1',
          copropiedadId: COP.toString(),
          actor: ACTOR,
        });
      });
    });

    describe('fila de PDF a nivel de lote tras el undo (R2)', () => {
      const armarUndo = (cantidad: number) => {
        const m = construirModelos({});
        const facturas = Array.from({ length: cantidad }, (_, i) =>
          facturaLean(1041 + i),
        );
        facturasQueSeLeen(m, () => facturas);
        const presentaciones = cruceCon();
        const n = numeracionConContador({
          prefijo: 'CONJ-2026',
          numero: 1041,
          resolucionId: RESOLUCION,
        });
        const { service } = construirServicio(m, n.numeracion, {
          presentaciones,
        });
        return { service, presentaciones };
      };

      it('al borrar facturas también borra la fila pendiente (generatedAt nulo) del PDF del lote', async () => {
        const t = armarUndo(2);
        const lote = loteDoc();

        await t.service.deshacerConsolidacion(lote as never, COP, null);

        expect(t.presentaciones.deleteMany).toHaveBeenCalledTimes(1);
        const [filtro, opciones] = t.presentaciones.deleteMany.mock
          .calls[0] as unknown as [Filtro, Filtro];
        expect(filtro).toEqual({
          tipoDocumento: 'FV',
          documentoId: lote._id,
          generatedAt: null,
        });
        expect(opciones).toHaveProperty('session');
      });

      it('con varios bloques la borra una sola vez, en la transacción del último', async () => {
        const t = armarUndo(45);

        await t.service.deshacerConsolidacion(loteDoc() as never, COP, null);

        expect(t.presentaciones.deleteMany).toHaveBeenCalledTimes(1);
      });

      it('sin facturas que borrar no toca la fila del PDF', async () => {
        const t = armarUndo(0);

        await t.service.deshacerConsolidacion(loteDoc() as never, COP, null);

        expect(t.presentaciones.deleteMany).not.toHaveBeenCalled();
      });
    });

    describe('rebobino del consecutivo FV fijado a su fila (R3)', () => {
      it('el contador de la reserva viaja con el _id del consecutivo y se devuelve tal cual', async () => {
        const m = construirModelos({
          previsualizacion: [preliminar()],
        });
        m.asientos.insertMany = jest
          .fn()
          .mockRejectedValueOnce(
            new Error('Mongo se cayó'),
          ) as typeof m.asientos.insertMany;
        facturasQueSeLeen(m, () => []);
        const OTRO_FV = new Types.ObjectId();
        const n = numeracionConContador({
          prefijo: 'FV',
          numero: 11,
          antes: 10,
          resolucionId: null,
          consecutivoId: OTRO_FV,
        });
        const { service } = construirServicio(m, n.numeracion);

        await service.consolidar('lote-1');

        expect(n.devolverContadorFacturas).toHaveBeenCalledWith(
          COP.toString(),
          expect.objectContaining({ consecutivoId: OTRO_FV }),
        );
      });
    });
  });
});

describe('LotesFacturacionService.findAll', () => {
  it('no revienta con un lote viejo al que le faltan fechaLimiteDescuento/fechaSuspension', async () => {
    // Esos dos campos son `required: true` pero SIN `default` — Mongoose solo
    // lo exige al guardar, nunca al leer, así que un lote creado antes de que
    // existieran esas columnas vuelve con `undefined` en las dos. Antes de
    // esta prueba, `.toISOString()` sobre ese `undefined` tumbaba TODA la
    // lista, no solo esta fila — justo lo que le pasó a Bernardo.
    const legado = loteDoc({
      fechaLimiteDescuento: undefined,
      fechaSuspension: undefined,
      fechaFacturacion: new Date('2026-07-01'),
      periodoHasta: new Date('2026-07-31'),
    });
    const lotes = {
      find: jest.fn(() => ({
        sort: () => ({ exec: () => Promise.resolve([legado]) }),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never,
      {} as never,
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      tenantQueDevuelve(COP),
      {} as never,
      numeracionCon(),
      {} as never, // connection
    );

    const resultado = await service.findAll();

    expect(resultado[0].fechaLimiteDescuento).toBe(
      new Date('2026-07-01').toISOString(),
    );
    expect(resultado[0].fechaSuspension).toBe(
      new Date('2026-07-31').toISOString(),
    );
  });
});

describe('LotesFacturacionService.findOne', () => {
  it('incluye la previsualización completa, no solo el conteo', async () => {
    const preliminar = {
      inmuebleId: { toString: () => 'inm-1' },
      codigoInmueble: '301',
      terceroId: { toString: () => 'ter-1' },
      titular: {
        nombre: 'Ana Pérez',
        tipoIdentificacion: 'CC',
        numeroIdentificacion: '123456',
        digitoVerificacion: null,
        direccion: null,
        ciudad: null,
        email: null,
      },
      lineas: [
        {
          conceptoId: { toString: () => 'con-1' },
          nombreConcepto: 'Administración',
          tipoConcepto: 'administracion',
          cuentaIngreso: '413501',
          origen: 'recurrente',
          valorBase: 520000,
          tasaImpuesto: 0,
          valorImpuesto: 0,
          valorTotal: 520000,
        },
      ],
      subtotal: 520000,
      totalImpuestos: 0,
      total: 520000,
    };
    const lotes = {
      findOne: jest.fn(() => ({
        exec: () =>
          Promise.resolve(loteDoc({ previsualizacion: [preliminar] })),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
      {} as never, // connection
    );

    const resultado = await service.findOne('lote-1');

    expect(resultado.previsualizacion).toEqual([
      expect.objectContaining({
        inmuebleId: 'inm-1',
        inmuebleCodigo: '301',
        terceroId: 'ter-1',
        titular: expect.objectContaining({
          nombre: 'Ana Pérez',
        }) as TitularFactura,
        lineas: [
          expect.objectContaining({
            conceptoId: 'con-1',
            nombreConcepto: 'Administración',
            origen: 'recurrente',
            valorTotal: 520000,
          }),
        ],
        subtotal: 520000,
        totalImpuestos: 0,
        total: 520000,
      }),
    ]);
  });

  it('lanza NotFoundException si el lote no existe para esta copropiedad', async () => {
    const lotes = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never,
      {} as never,
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      tenantQueDevuelve(COP),
      {} as never,
      numeracionCon(),
      {} as never, // connection
    );

    await expect(service.findOne('lote-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('LotesFacturacionService.cancelar', () => {
  const periodoEspia = () => ({
    exigirAbierto: jest.fn().mockResolvedValue(undefined),
  });

  const construir = (lotes: unknown, periodo: unknown = periodoEspia()) =>
    new LotesFacturacionService(
      lotes as never,
      // facturas: ningún lote de estos tests tiene facturas emitidas.
      { exists: () => ({ exec: () => Promise.resolve(null) }) } as never,
      {} as never, // saldos
      {} as never, // carteraPorDocumento
      {} as never, // saldoTotalDocumento
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      periodo as never,
      numeracionCon(),
      {} as never, // connection
    );

  /** Model of the lote as `cancelar` sees it: `reclamado` is what the atomic
   *  claim returns (null = it did not match), `existente` what the
   *  diagnostic `findOne` finds after a missed claim. */
  const lotesCancelar = (opts: {
    reclamado?: Record<string, unknown> | null;
    existente?: Record<string, unknown> | null;
    borrados?: number;
  }) => ({
    findOneAndUpdate: jest.fn((_filtro?: Filtro, _act?: Filtro) => ({
      exec: () =>
        Promise.resolve(
          opts.reclamado === undefined
            ? loteDoc({ estado: 'borrador' })
            : opts.reclamado,
        ),
    })),
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(opts.existente ?? null),
    })),
    deleteOne: jest.fn((_filtro?: Filtro) => ({
      exec: () => Promise.resolve({ deletedCount: opts.borrados ?? 1 }),
    })),
    updateOne: jest.fn((_filtro?: Filtro, _act?: Filtro) => ({
      exec: () => Promise.resolve({ matchedCount: 1 }),
    })),
  });

  const tokenDe = (lotes: ReturnType<typeof lotesCancelar>): string =>
    (
      lotes.findOneAndUpdate.mock.calls[0][1] as {
        $set: { reclamoToken: string };
      }
    ).$set.reclamoToken;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('borra un lote en borrador — el caso típico: parámetros mal cargados y hay que empezar de nuevo', async () => {
    const lotes = lotesCancelar({});
    const service = construir(lotes);

    await service.cancelar('lote-1', ACTOR);

    // Conditional on still owning the claim it took.
    expect(lotes.deleteOne).toHaveBeenCalledWith({
      _id: 'lote-1',
      copropiedadId: COP,
      reclamoToken: tokenDe(lotes),
    });
  });

  it('también borra uno en liquidado — todavía no generó ninguna factura real', async () => {
    const lotes = lotesCancelar({
      reclamado: loteDoc({ estado: 'liquidado' }),
    });
    const service = construir(lotes);

    await service.cancelar('lote-1', ACTOR);

    expect(lotes.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('reclama el lote con UN findOneAndUpdate atómico: borrador/liquidado y progreso nulo o vencido, con un token nuevo', async () => {
    const ahora = new Date('2026-09-01T12:00:00Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(ahora);
    const lotes = lotesCancelar({});
    const service = construir(lotes);

    await service.cancelar('lote-1', ACTOR);

    expect(lotes.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro, act, opciones] = lotes.findOneAndUpdate.mock
      .calls[0] as unknown as [Filtro, Filtro, Filtro];
    expect(filtro).toEqual({
      _id: 'lote-1',
      copropiedadId: COP,
      estado: { $in: ['borrador', 'liquidado'] },
      $or: [
        { progreso: null },
        { updatedAt: { $lt: new Date(ahora - 15 * 60 * 1000) } },
      ],
    });
    expect(act).toEqual({
      $set: {
        progreso: { actual: 0, total: 0 },
        reclamoToken: expect.any(String) as unknown,
      },
    });
    expect(opciones).toEqual({ returnDocument: 'after' });
  });

  it('un reclamo VENCIDO (más de 15 min) se retoma y un periodo cerrado nunca bloquea: no consulta exigirAbierto', async () => {
    const periodo = {
      exigirAbierto: jest
        .fn()
        .mockRejectedValue(new ConflictException('periodo cerrado')),
    };
    // El filtro del reclamo admite el vencido; el modelo lo devuelve.
    const lotes = lotesCancelar({
      reclamado: loteDoc({
        estado: 'liquidado',
        progreso: { actual: 3, total: 10 },
      }),
    });
    const service = construir(lotes, periodo);

    await service.cancelar('lote-1', ACTOR);

    expect(periodo.exigirAbierto).not.toHaveBeenCalled();
    expect(lotes.deleteOne).toHaveBeenCalledTimes(1);
  });

  it('un reclamo FRESCO de una consolidación lo rechaza con Conflict claro, sin borrar ni liberar lo ajeno', async () => {
    const lotes = lotesCancelar({
      reclamado: null,
      existente: loteDoc({
        estado: 'liquidado',
        progreso: { actual: 20, total: 100 },
      }),
    });
    const service = construir(lotes);

    const intento = service.cancelar('lote-1', ACTOR);

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(/consolidación en curso/);
    expect(lotes.deleteOne).not.toHaveBeenCalled();
    expect(lotes.updateOne).not.toHaveBeenCalled();
  });

  it('rechaza cancelar uno consolidado: ya generó facturas reales', async () => {
    const lotes = lotesCancelar({
      reclamado: null,
      existente: loteDoc({ estado: 'consolidado' }),
    });
    const service = construir(lotes);

    const intento = service.cancelar('lote-1', ACTOR);

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(/ya está consolidado/);
    expect(lotes.deleteOne).not.toHaveBeenCalled();
  });

  it('lanza NotFoundException si el lote no existe para esta copropiedad', async () => {
    const lotes = lotesCancelar({ reclamado: null, existente: null });
    const service = construir(lotes);

    await expect(service.cancelar('lote-ajeno', ACTOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(lotes.deleteOne).not.toHaveBeenCalled();
  });

  describe('con facturas ya emitidas por una corrida fallida o interrumpida', () => {
    const RESOLUCION = new Types.ObjectId();

    const cruceCon = (filas: Record<string, unknown>[] = []) => ({
      find: jest.fn((_filtro?: Filtro, _proyeccion?: Filtro) => ({
        session: () => ({
          lean: () => ({ exec: () => Promise.resolve(filas) }),
        }),
      })),
      // Pending lote-level PDF rows deleted by the undo.
      deleteMany: jest.fn((_filtro?: Filtro, _opciones?: Filtro) =>
        Promise.resolve({ deletedCount: 0 }),
      ),
    });

    const facturaLean = (
      n: number,
      resolucionId: Types.ObjectId | null,
      prefijo = 'FV',
    ) => ({
      _id: new Types.ObjectId(),
      inmuebleId: new Types.ObjectId(),
      numero: n,
      numeroCompleto: `F-${n}`,
      prefijo,
      resolucionId,
      lineas: [{ conceptoId: new Types.ObjectId(), valorTotal: 100 }],
    });

    const armar = (
      facturasLote: ReturnType<typeof facturaLean>[],
      opts: {
        devuelve?: boolean;
        /** Per-call result of `devolverContadorFacturas` (wins over `devuelve`). */
        devuelveSecuencia?: boolean[];
        aplicaciones?: ReturnType<typeof cruceCon>;
        progreso?: { actual: number; total: number } | null;
        /** `deletedCount` of the final conditional `deleteOne`. */
        borrados?: number;
        /** What `ubicarConsecutivoFV` answers, by prefix (default: the one id). */
        consecutivoFV?: (prefijo: string) => Types.ObjectId | null;
      } = {},
    ) => {
      const orden: string[] = [];
      const lotes = {
        // Atomic claim: misses when another run holds a (fresh) claim.
        findOneAndUpdate: jest.fn((_filtro?: Filtro, _act?: Filtro) => {
          orden.push('reclamo');
          return {
            exec: () =>
              Promise.resolve(
                opts.progreso ? null : loteDoc({ estado: 'liquidado' }),
              ),
          };
        }),
        // Diagnostic read after a missed claim.
        findOne: jest.fn(() => ({
          exec: () =>
            Promise.resolve(
              loteDoc({ estado: 'liquidado', progreso: opts.progreso ?? null }),
            ),
        })),
        updateOne: jest.fn((_filtro?: Filtro, _act?: Filtro) => {
          orden.push('liberar');
          return { exec: () => Promise.resolve({ matchedCount: 1 }) };
        }),
        deleteOne: jest.fn((_filtro?: Filtro) => {
          orden.push('deleteOne');
          return {
            exec: () => Promise.resolve({ deletedCount: opts.borrados ?? 1 }),
          };
        }),
      };
      const facturas = {
        exists: jest.fn(() => ({
          exec: () =>
            Promise.resolve(facturasLote.length ? { _id: 'x' } : null),
        })),
        find: jest.fn(() => ({
          lean: () => ({ exec: () => Promise.resolve(facturasLote) }),
        })),
        deleteMany: jest.fn((_filtro?: Filtro, _opciones?: Filtro) => {
          orden.push('deleteMany');
          return Promise.resolve({ deletedCount: facturasLote.length });
        }),
      };
      const vacio = {
        deleteMany: jest.fn(() => Promise.resolve({})),
        bulkWrite: jest.fn(() => Promise.resolve({})),
        // Orphan guard: every Factura has its asiento (echoed back).
        find: jest.fn((filtro?: Filtro) => ({
          lean: () => ({
            exec: () =>
              Promise.resolve(
                (
                  (filtro?.facturaId as { $in?: unknown[] } | undefined)?.$in ??
                  []
                ).map((facturaId) => ({ facturaId })),
              ),
          }),
        })),
      };
      let llamadasDevolver = 0;
      const devolverContadorFacturas = jest.fn(
        (_copropiedadId: string, _contador: unknown) => {
          orden.push('devolver');
          const i = llamadasDevolver;
          llamadasDevolver += 1;
          return Promise.resolve(
            opts.devuelveSecuencia?.[i] ?? opts.devuelve ?? true,
          );
        },
      );
      const ubicarConsecutivoFV = jest.fn((_cop: string, prefijo: string) =>
        Promise.resolve(
          opts.consecutivoFV ? opts.consecutivoFV(prefijo) : CONSECUTIVO_FV,
        ),
      );
      const numeracion = {
        devolverContadorFacturas,
        ubicarConsecutivoFV,
      } as unknown as NumeracionService;
      const copropiedades = {
        findById: jest.fn(() => ({
          exec: () =>
            Promise.resolve({
              codigo: 'CONJ-01',
              nombre: 'Conjunto Los Pinos',
            }),
        })),
      };
      const auditoria = {
        registrar: jest.fn((_entrada: Record<string, unknown>) =>
          Promise.resolve(),
        ),
      };
      const periodo = periodoEspia();
      const service = new LotesFacturacionService(
        lotes as never,
        facturas as never,
        vacio as never, // saldos
        vacio as never, // carteraPorDocumento
        vacio as never, // saldoTotalDocumento
        vacio as never, // asientos
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        copropiedades as never,
        tenantQueDevuelve(COP),
        periodo as never,
        numeracion,
        {
          startSession: jest.fn(() =>
            Promise.resolve({
              withTransaction: (fn: () => Promise<unknown>) => fn(),
              endSession: jest.fn(() => Promise.resolve(undefined)),
            }),
          ),
        } as never,
        undefined,
        undefined,
        undefined,
        (opts.aplicaciones ?? cruceCon()) as never,
        cruceCon() as never,
        cruceCon() as never,
        cruceCon() as never,
        auditoria as never,
        cruceCon() as never, // publicacionesLote
      );
      return {
        service,
        lotes,
        periodo,
        facturas,
        devolverContadorFacturas,
        ubicarConsecutivoFV,
        auditoria,
        orden,
      };
    };

    it('un lote sin facturas se cancela como siempre: no deshace nada ni toca el contador', async () => {
      const t = armar([]);

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.lotes.deleteOne).toHaveBeenCalledTimes(1);
      expect(t.facturas.find).not.toHaveBeenCalled();
      expect(t.devolverContadorFacturas).not.toHaveBeenCalled();
      expect(t.auditoria.registrar).not.toHaveBeenCalled();
    });

    it('con resolución: deshace las facturas, devuelve el contador al mínimo y recién después borra el lote', async () => {
      const t = armar([
        facturaLean(1041, RESOLUCION),
        facturaLean(1043, RESOLUCION),
        facturaLean(1042, RESOLUCION),
      ]);

      await t.service.cancelar('lote-1', ACTOR);

      // Resolución: siguienteNumero es el PRÓXIMO a emitir, así que estaba
      // en max + 1 y vuelve a min.
      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: RESOLUCION,
        consecutivoId: null,
        antes: 1041,
        despues: 1044,
      });
      expect(t.orden).toEqual([
        'reclamo',
        'deleteMany',
        'devolver',
        'deleteOne',
      ]);
      expect(t.auditoria.registrar).toHaveBeenCalledTimes(1);
    });

    it('con consecutivo FV: siguienteNumero es el ÚLTIMO emitido, así que estaba en max y vuelve a min - 1', async () => {
      const t = armar([facturaLean(11, null), facturaLean(12, null)]);

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: null,
        consecutivoId: CONSECUTIVO_FV,
        antes: 10,
        despues: 12,
      });
    });

    it('si el contador no está al final del rango del lote, no lo toca, lo informa en la auditoría y cancela igual', async () => {
      const t = armar([facturaLean(1041, RESOLUCION)], { devuelve: false });

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.lotes.deleteOne).toHaveBeenCalledTimes(1);
      expect(t.auditoria.registrar.mock.calls[0][0].entidadEtiqueta).toContain(
        'consecutivo NO devuelto',
      );
    });

    it('con facturas de dos resoluciones distintas rebobina CADA contador por separado, con su propio mínimo y máximo', async () => {
      const OTRA = new Types.ObjectId();
      const t = armar([
        facturaLean(100, RESOLUCION),
        facturaLean(101, RESOLUCION),
        facturaLean(5, OTRA),
        facturaLean(6, OTRA),
      ]);

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.devolverContadorFacturas).toHaveBeenCalledTimes(2);
      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: RESOLUCION,
        consecutivoId: null,
        antes: 100,
        despues: 102,
      });
      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: OTRA,
        consecutivoId: null,
        antes: 5,
        despues: 7,
      });
    });

    it('con una resolución y el consecutivo FV de respaldo en el mismo lote, cada uno en su propia semántica', async () => {
      const t = armar([
        facturaLean(1041, RESOLUCION),
        facturaLean(11, null),
        facturaLean(12, null),
      ]);

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.devolverContadorFacturas).toHaveBeenCalledTimes(2);
      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: RESOLUCION,
        consecutivoId: null,
        antes: 1041,
        despues: 1042,
      });
      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: null,
        consecutivoId: CONSECUTIVO_FV,
        antes: 10,
        despues: 12,
      });
    });

    it('nunca baja un contador por debajo de un número que sigue existiendo: solo devuelve la racha contigua final del grupo', async () => {
      // 13..19 pertenecen a otro lote: el rango 10..21 NO es del lote.
      const t = armar([
        facturaLean(10, RESOLUCION),
        facturaLean(11, RESOLUCION),
        facturaLean(12, RESOLUCION),
        facturaLean(20, RESOLUCION),
        facturaLean(21, RESOLUCION),
      ]);

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.devolverContadorFacturas).toHaveBeenCalledTimes(1);
      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: RESOLUCION,
        consecutivoId: null,
        antes: 20,
        despues: 22,
      });
    });

    it('si uno de los contadores no está en su cola, ese queda intacto, se informa en la auditoría y cancela igual', async () => {
      const OTRA = new Types.ObjectId();
      const t = armar([facturaLean(100, RESOLUCION), facturaLean(5, OTRA)], {
        devuelveSecuencia: [true, false],
      });

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.devolverContadorFacturas).toHaveBeenCalledTimes(2);
      expect(t.lotes.deleteOne).toHaveBeenCalledTimes(1);
      expect(t.auditoria.registrar.mock.calls[0][0].entidadEtiqueta).toContain(
        'consecutivo NO devuelto',
      );
    });

    it('rechaza cancelar mientras hay una consolidación en curso (reclamo fresco): no lee ni borra nada', async () => {
      const t = armar([facturaLean(1041, RESOLUCION)], {
        progreso: { actual: 20, total: 100 },
      });

      const intento = t.service.cancelar('lote-1', ACTOR);

      await expect(intento).rejects.toBeInstanceOf(ConflictException);
      await expect(intento).rejects.toThrow(/consolidación en curso/);
      expect(t.facturas.exists).not.toHaveBeenCalled();
      expect(t.facturas.find).not.toHaveBeenCalled();
      expect(t.facturas.deleteMany).not.toHaveBeenCalled();
      expect(t.devolverContadorFacturas).not.toHaveBeenCalled();
      expect(t.lotes.deleteOne).not.toHaveBeenCalled();
    });

    it('rechaza cancelar si la guarda de cruces lo impide: no borra facturas ni el lote', async () => {
      const facturas = [facturaLean(1041, RESOLUCION)];
      const t = armar(facturas, {
        aplicaciones: cruceCon([{ documentoId: facturas[0]._id }]),
      });

      await expect(t.service.cancelar('lote-1', ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(t.facturas.deleteMany).not.toHaveBeenCalled();
      expect(t.devolverContadorFacturas).not.toHaveBeenCalled();
      expect(t.lotes.deleteOne).not.toHaveBeenCalled();
    });

    it('el borrado final es condicional al token del reclamo que tomó cancelar', async () => {
      const t = armar([]);

      await t.service.cancelar('lote-1', ACTOR);

      const token = (
        t.lotes.findOneAndUpdate.mock.calls[0][1] as {
          $set: { reclamoToken: string };
        }
      ).$set.reclamoToken;
      expect(t.lotes.deleteOne).toHaveBeenCalledWith({
        _id: 'lote-1',
        copropiedadId: COP,
        reclamoToken: token,
      });
    });

    it('si el borrado condicional no coincide con nada (otra corrida tomó el reclamo vencido) lanza Conflict y NO libera lo ajeno', async () => {
      const t = armar([], { borrados: 0 });

      const intento = t.service.cancelar('lote-1', ACTOR);

      await expect(intento).rejects.toBeInstanceOf(ConflictException);
      await expect(intento).rejects.toThrow(/perdió el reclamo del lote/);
      expect(t.lotes.updateOne).not.toHaveBeenCalled();
    });

    it('un consolidar concurrente se rechaza mientras cancelar tiene el reclamo (en pleno undo)', async () => {
      const t = armar([facturaLean(1041, RESOLUCION)]);
      // Stateful claim: the first taker wins, later ones miss.
      let tomado = false;
      t.lotes.findOneAndUpdate.mockImplementation(() => {
        const gana = !tomado;
        tomado = true;
        return {
          exec: () =>
            Promise.resolve(gana ? loteDoc({ estado: 'liquidado' }) : null),
        };
      });
      let rechazoConsolidar: unknown;
      t.facturas.deleteMany.mockImplementation(async () => {
        // A consolidación arrives while the undo is deleting Facturas.
        try {
          await t.service.consolidar('lote-1');
        } catch (err) {
          rechazoConsolidar = err;
        }
        return { deletedCount: 1 };
      });

      await t.service.cancelar('lote-1', ACTOR);

      expect(rechazoConsolidar).toBeInstanceOf(ConflictException);
      expect((rechazoConsolidar as Error).message).toMatch(/en curso/);
      expect(t.lotes.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('si el undo falla (la guarda de cruces lo impide) libera el reclamo condicionado al token y no borra el lote', async () => {
      const facturas = [facturaLean(1041, RESOLUCION)];
      const t = armar(facturas, {
        aplicaciones: cruceCon([{ documentoId: facturas[0]._id }]),
      });

      await expect(t.service.cancelar('lote-1', ACTOR)).rejects.toBeInstanceOf(
        ConflictException,
      );

      const token = (
        t.lotes.findOneAndUpdate.mock.calls[0][1] as {
          $set: { reclamoToken: string };
        }
      ).$set.reclamoToken;
      expect(t.lotes.updateOne).toHaveBeenCalledTimes(1);
      expect(t.lotes.updateOne).toHaveBeenCalledWith(
        { _id: 'lote-1', copropiedadId: COP, reclamoToken: token },
        { $set: { progreso: null, reclamoToken: null } },
      );
      expect(t.lotes.deleteOne).not.toHaveBeenCalled();
    });

    it('con un reclamo vencido y facturas a medias, deshace y borra sin consultar el estado del periodo', async () => {
      const t = armar([facturaLean(1041, RESOLUCION)]);

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.periodo.exigirAbierto).not.toHaveBeenCalled();
      expect(t.lotes.deleteOne).toHaveBeenCalledTimes(1);
    });

    it('la auditoría registra a quien canceló, con copropiedad, número de lote y motivo', async () => {
      const t = armar([facturaLean(1041, RESOLUCION)]);

      await t.service.cancelar('lote-1', ACTOR);

      const entrada = t.auditoria.registrar.mock.calls[0][0];
      expect(entrada).toMatchObject({
        actorAccountId: 'cuenta-actora',
        actorNombre: 'Ana Actora',
        accion: 'revertir',
        entidadTipo: 'lote-facturacion',
        entidadId: 'lote-1',
      });
      expect(entrada.entidadEtiqueta).toContain('CONJ-01 Conjunto Los Pinos');
      expect(entrada.entidadEtiqueta).toContain('Lote 1');
      expect(entrada.entidadEtiqueta).toContain('reversión por cancelación');
    });

    it('con dos consecutivos FV de prefijos distintos los agrupa por prefijo y rebobina cada uno en SU fila', async () => {
      const FV_A = new Types.ObjectId();
      const FV_B = new Types.ObjectId();
      const t = armar(
        [
          facturaLean(11, null, 'FVA'),
          facturaLean(12, null, 'FVA'),
          facturaLean(5, null, 'FVB'),
        ],
        { consecutivoFV: (prefijo) => (prefijo === 'FVA' ? FV_A : FV_B) },
      );

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.ubicarConsecutivoFV).toHaveBeenCalledWith(COP.toString(), 'FVA');
      expect(t.ubicarConsecutivoFV).toHaveBeenCalledWith(COP.toString(), 'FVB');
      expect(t.devolverContadorFacturas).toHaveBeenCalledTimes(2);
      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: null,
        consecutivoId: FV_A,
        antes: 10,
        despues: 12,
      });
      expect(t.devolverContadorFacturas).toHaveBeenCalledWith(COP.toString(), {
        resolucionId: null,
        consecutivoId: FV_B,
        antes: 4,
        despues: 5,
      });
    });

    it('si el consecutivo FV no se ubica de forma inequívoca no rebobina, lo informa en la auditoría y cancela igual', async () => {
      const t = armar([facturaLean(11, null, 'FVA')], {
        consecutivoFV: () => null,
      });

      await t.service.cancelar('lote-1', ACTOR);

      expect(t.devolverContadorFacturas).not.toHaveBeenCalled();
      expect(t.lotes.deleteOne).toHaveBeenCalledTimes(1);
      expect(t.auditoria.registrar.mock.calls[0][0].entidadEtiqueta).toContain(
        'no se pudo ubicar de forma inequívoca',
      );
    });
  });
});

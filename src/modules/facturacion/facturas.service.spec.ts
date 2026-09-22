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
  // No longer a real field on the document (see `SaldoTotalDocumento`'s own
  // docblock) — kept on this fixture purely as the INPUT the test mocks
  // below (`modeloSaldoTotalDocumento`) read to build their own live rows,
  // never read by `FacturasService` itself anymore.
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
    lean: () => cadena,
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

/** `SaldoTotalDocumento` mock, backed by the same fixtures passed to
 *  `modeloCon` — reads each document's own `outstandingBalance` field as the
 *  live `saldoPendiente` it now stands in for (see `facturas.service.ts`'s
 *  own docblock). Handles both query shapes `FacturasService` makes: the
 *  `conSaldoPendiente` candidate query (no `documentoId` filter, just
 *  `saldoPendiente: { $gt: 0 }`) and the post-page batch lookup
 *  (`documentoId: { $in: [...] }`, unfiltered by balance). */
const modeloSaldoTotalDocumento = (
  filas: { _id: { toString(): string }; outstandingBalance?: number }[],
) => {
  const filtros: Filtro[] = [];
  return {
    filtros,
    find: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      const idsFiltro = (filtro.documentoId as { $in?: unknown[] } | undefined)
        ?.$in;
      const resultado = idsFiltro
        ? filas.filter((f) => idsFiltro.map(String).includes(f._id.toString()))
        : filas.filter((f) => (f.outstandingBalance ?? 0) > 0);
      return {
        exec: () =>
          Promise.resolve(
            resultado.map((f) => ({
              documentoId: f._id,
              saldoPendiente: f.outstandingBalance ?? 0,
            })),
          ),
      };
    }),
    findOne: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      const fila = filas.find(
        (f) =>
          f._id.toString() ===
          (filtro.documentoId as { toString(): string }).toString(),
      );
      return {
        exec: () =>
          Promise.resolve(
            fila
              ? {
                  documentoId: fila._id,
                  saldoPendiente: fila.outstandingBalance ?? 0,
                }
              : null,
          ),
      };
    }),
  };
};

/** `CarteraPorDocumento` mock, deriving each línea's own `saldoPendiente`
 *  from that línea's frozen `totalAmount` (none of these fixtures model a
 *  partial payment) — enough for `toFactura`'s per-línea breakdown, never
 *  asserted on in detail by the tests below. */
const modeloCarteraPorDocumento = (
  filas: {
    _id: { toString(): string };
    lines: { conceptoId: { toString(): string }; totalAmount: number }[];
  }[],
) => ({
  find: jest.fn((filtro: Filtro) => {
    const idsFiltro =
      (filtro.documentoId as { $in?: unknown[] } | undefined)?.$in ?? [];
    const ids = idsFiltro.map(String);
    const filas_ = filas
      .filter((f) => ids.includes(f._id.toString()))
      .flatMap((f) =>
        f.lines.map((linea) => ({
          documentoId: f._id,
          conceptoId: linea.conceptoId,
          saldoPendiente: linea.totalAmount,
        })),
      );
    return { exec: () => Promise.resolve(filas_) };
  }),
});

const tenantQueDevuelve = (id: Types.ObjectId | null): TenantContextService =>
  ({
    resolveCoPropertyId: () => {
      if (id === null) throw new ForbiddenException('sin copropiedad activa');
      return id;
    },
  }) as unknown as TenantContextService;

/** Empty `find().exec() => []` stub — enough for the models
 *  `datosVisualesPdf` needs but the `findAll`/`findOne`/`findAllRawPorLote`
 *  suites below never exercise. */
const modeloVacio = () => ({
  find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
});

/** Builds a `FacturasService` wired against the SAME set of fixtures across
 *  all three of its models — `facturas`, `saldoTotalDocumento`,
 *  `carteraPorDocumento` — so a test only has to declare its documento(s)
 *  once. `inmuebles`/`recibos`/`saldoDocumentoOrigen` default to empty stubs
 *  — only `construirServicioAnticipos` below wires those for real. */
const construirServicio = (filas: ReturnType<typeof documento>[]) => {
  const facturas = modeloCon(filas);
  const saldoTotalDocumento = modeloSaldoTotalDocumento(filas);
  const carteraPorDocumento = modeloCarteraPorDocumento(filas);
  const service = new FacturasService(
    facturas as never,
    saldoTotalDocumento as never,
    carteraPorDocumento as never,
    modeloVacio() as never,
    modeloVacio() as never,
    modeloVacio() as never,
    tenantQueDevuelve(COP),
  );
  return { service, facturas, saldoTotalDocumento, carteraPorDocumento };
};

describe('FacturasService.findAll', () => {
  it('filtra SIEMPRE por la copropiedad activa', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({});

    expect(facturas.filtros[0].coPropertyId).toBe(COP);
  });

  it('devuelve el contrato en español, con el titular congelado', async () => {
    const { service } = construirServicio([documento()]);

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
    const { service, facturas } = construirServicio([documento()]);

    await service.findOne('fac-1');

    expect(facturas.filtros[0]).toEqual({ _id: 'fac-1', coPropertyId: COP });
  });

  it('responde "no existe" para una factura de otra copropiedad', async () => {
    const { service } = construirServicio([]);

    await expect(service.findOne('fac-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('FacturasService.findAll — conSaldoPendiente', () => {
  it('filtra por SaldoTotalDocumento.saldoPendiente > 0 cuando conSaldoPendiente es true', async () => {
    const doc = documento();
    const { service, facturas, saldoTotalDocumento } = construirServicio([doc]);

    await service.findAll({ conSaldoPendiente: true });

    expect(saldoTotalDocumento.filtros[0]).toMatchObject({
      coPropertyId: COP,
      tipoDocumento: 'FV',
      saldoPendiente: { $gt: 0 },
    });
    expect(facturas.filtros[0]).toMatchObject({
      status: 'emitida',
      _id: { $in: [doc._id] },
    });
  });

  it('no aplica el filtro cuando conSaldoPendiente es false o ausente', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({});

    expect(facturas.filtros[0]._id).toBeUndefined();
    expect(facturas.filtros[0].status).toBeUndefined();
  });
});

describe('FacturasService.findAll — estado', () => {
  it('filtra por status cuando se pasa estado', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({ estado: 'anulada' });

    expect(facturas.filtros[0].status).toBe('anulada');
  });

  it('estado explícito gana por sobre el status implícito de conSaldoPendiente', async () => {
    const doc = documento();
    const { service, facturas } = construirServicio([doc]);

    await service.findAll({ estado: 'anulada', conSaldoPendiente: true });

    expect(facturas.filtros[0]).toMatchObject({
      status: 'anulada',
      _id: { $in: [doc._id] },
    });
  });

  it('no aplica el filtro cuando estado está ausente', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({});

    expect(facturas.filtros[0].status).toBeUndefined();
  });
});

describe('FacturasService.findAll — fechaDesde/fechaHasta', () => {
  it('filtra issueDate por rango cuando se pasan ambos extremos', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({
      fechaDesde: '2026-08-01',
      fechaHasta: '2026-08-31',
    });

    expect(facturas.filtros[0].issueDate).toEqual({
      $gte: new Date('2026-08-01'),
      $lte: new Date('2026-08-31'),
    });
  });

  it('filtra con un solo extremo cuando el otro está ausente', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({ fechaDesde: '2026-08-01' });

    expect(facturas.filtros[0].issueDate).toEqual({
      $gte: new Date('2026-08-01'),
    });
  });

  it('no aplica el filtro cuando ambos extremos están ausentes', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({});

    expect(facturas.filtros[0].issueDate).toBeUndefined();
  });
});

describe('FacturasService.findAll — buscar', () => {
  it('filtra por fullNumber con regex insensible a mayúsculas cuando se pasa buscar', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({ buscar: '1041' });

    expect(facturas.filtros[0].fullNumber).toEqual({
      $regex: '1041',
      $options: 'i',
    });
  });

  it('escapa caracteres especiales de regex en buscar', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({ buscar: 'CONJ-2026(1041)' });

    expect((facturas.filtros[0].fullNumber as { $regex: string }).$regex).toBe(
      'CONJ-2026\\(1041\\)',
    );
  });

  it('no aplica el filtro cuando buscar está ausente', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAll({});

    expect(facturas.filtros[0].fullNumber).toBeUndefined();
  });
});

describe('FacturasService.findAllRawPorLote', () => {
  it('filtra por copropiedad Y loteId, ordenado por código de unidad', async () => {
    const { service, facturas } = construirServicio([documento()]);

    await service.findAllRawPorLote('lote-1');

    expect(facturas.filtros[0]).toEqual({
      coPropertyId: COP,
      loteId: 'lote-1',
    });
  });

  it('devuelve los documentos crudos, no el contrato mapeado', async () => {
    const { service } = construirServicio([documento()]);

    const resultado = await service.findAllRawPorLote('lote-1');

    expect(resultado[0]).toMatchObject({ fullNumber: 'CONJ-2026-1041' });
  });
});

describe('FacturasService.datosVisualesPdf', () => {
  const construirServicioAnticipos = (config: {
    inmuebles: { _id: Types.ObjectId; reference: string | null }[];
    recibos: {
      _id: Types.ObjectId;
      inmuebleId: Types.ObjectId;
      status: 'activo' | 'anulado';
    }[];
    saldos: { documentoId: Types.ObjectId; saldoDisponible: number }[];
  }) => {
    const inmuebles = {
      find: jest.fn(() => ({ exec: () => Promise.resolve(config.inmuebles) })),
    };
    const recibos = {
      find: jest.fn((filtro: Filtro) => ({
        exec: () =>
          Promise.resolve(
            config.recibos.filter((r) => r.status === filtro.status),
          ),
      })),
    };
    const saldoDocumentoOrigen = {
      find: jest.fn(() => ({ exec: () => Promise.resolve(config.saldos) })),
    };
    const service = new FacturasService(
      modeloCon([]) as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloCarteraPorDocumento([]) as never,
      inmuebles as never,
      recibos as never,
      saldoDocumentoOrigen as never,
      tenantQueDevuelve(COP),
    );
    return { service, inmuebles, recibos, saldoDocumentoOrigen };
  };

  it('suma el saldo disponible de los recibos activos del inmueble como totalAnticipos', async () => {
    const inmuebleId = new Types.ObjectId();
    const recibo1 = new Types.ObjectId();
    const recibo2 = new Types.ObjectId();
    const { service } = construirServicioAnticipos({
      inmuebles: [{ _id: inmuebleId, reference: 'REF-301' }],
      recibos: [
        { _id: recibo1, inmuebleId, status: 'activo' },
        { _id: recibo2, inmuebleId, status: 'activo' },
      ],
      saldos: [
        { documentoId: recibo1, saldoDisponible: 30000 },
        { documentoId: recibo2, saldoDisponible: 20000 },
      ],
    });

    const resultado = await service.datosVisualesPdf([inmuebleId]);

    expect(resultado.get(inmuebleId.toString())).toEqual({
      referencia: 'REF-301',
      totalAnticipos: 50000,
    });
  });

  it('devuelve totalAnticipos en 0 cuando el inmueble no tiene anticipo pendiente', async () => {
    const inmuebleId = new Types.ObjectId();
    const { service } = construirServicioAnticipos({
      inmuebles: [{ _id: inmuebleId, reference: null }],
      recibos: [],
      saldos: [],
    });

    const resultado = await service.datosVisualesPdf([inmuebleId]);

    expect(resultado.get(inmuebleId.toString())).toEqual({
      referencia: null,
      totalAnticipos: 0,
    });
  });

  it('devuelve un mapa vacío sin consultar nada cuando no se piden inmuebles', async () => {
    const { service, inmuebles, recibos } = construirServicioAnticipos({
      inmuebles: [],
      recibos: [],
      saldos: [],
    });

    const resultado = await service.datosVisualesPdf([]);

    expect(resultado.size).toBe(0);
    expect(inmuebles.find).not.toHaveBeenCalled();
    expect(recibos.find).not.toHaveBeenCalled();
  });
});

/** Minimal `Copropiedad` fixture — every field `emisorDe`/
 *  `datosPlantillaPreliminar` reads. */
const copropiedadBase = (over: Record<string, unknown> = {}) => ({
  name: 'Conjunto Residencial Alcázares',
  taxId: '900123456',
  taxIdVerificationDigit: '7',
  address: 'Calle 1 # 2-3',
  city: 'Bogotá',
  phone: '6011234567',
  email: 'admin@alcazares.com',
  showLogoOnDocuments: true,
  billingNotes: null,
  discountAppliesWithLateFee: false,
  ...over,
});

/** A `FacturaLean`-shaped fixture — the plain fields `datosPlantilla` reads
 *  off an already-issued invoice. */
const facturaParaPlantilla = (over: Record<string, unknown> = {}) => ({
  inmuebleId: new Types.ObjectId(),
  coPropertyId: COP,
  resolucionId: null,
  prefix: 'CONJ-2026',
  discountAmount: 0,
  discountDeadline: null,
  holder: {
    name: 'Ana Pérez',
    identificationType: 'CC',
    identificationNumber: '123456',
    identificationVerificationDigit: null,
    address: null,
    city: null,
    email: null,
  },
  lines: [
    {
      conceptoId: { toString: () => 'con-1' },
      conceptName: 'Administración',
      conceptKind: 'administracion',
      baseAmount: 520000,
      taxRate: 0,
      taxAmount: 0,
      totalAmount: 520000,
      balanceBefore: 0,
      balanceAfter: 520000,
    },
  ],
  ...over,
});

/** Builds a `FacturasService` wired with a mocked `TituloDocumentoService` —
 *  the only extra dependency `datosPlantilla` needs beyond `construirServicio`
 *  above. Every other model is an empty stub, same convention. */
const construirServicioConTitulo = (
  resolverFacturaResultado: {
    titulo: string;
    resolucion: unknown;
  } = { titulo: 'Cobro Expensas Comunes', resolucion: null },
) => {
  const tituloDocumento = {
    resolverGenerico: jest.fn(),
    resolverFactura: jest.fn(() => Promise.resolve(resolverFacturaResultado)),
  };
  const service = new FacturasService(
    modeloCon([]) as never,
    modeloSaldoTotalDocumento([]) as never,
    modeloCarteraPorDocumento([]) as never,
    modeloVacio() as never,
    modeloVacio() as never,
    modeloVacio() as never,
    tenantQueDevuelve(COP),
    tituloDocumento as never,
  );
  return { service, tituloDocumento };
};

describe('FacturasService.datosPlantilla', () => {
  it('llama a TituloDocumentoService.resolverFactura con el coPropertyId, el resolucionId y el prefix PROPIOS de la factura', async () => {
    const { service, tituloDocumento } = construirServicioConTitulo();
    const resolucionId = new Types.ObjectId();
    const factura = facturaParaPlantilla({
      resolucionId,
      prefix: 'CONJ-2026-1041',
    });

    await service.datosPlantilla(factura as never, copropiedadBase() as never, {
      referencia: null,
      totalAnticipos: 0,
    });

    expect(tituloDocumento.resolverFactura).toHaveBeenCalledWith(
      COP,
      resolucionId,
      'CONJ-2026-1041',
    );
  });

  it('arma emisor directamente desde la copropiedad recibida, sin ninguna query adicional', async () => {
    const { service } = construirServicioConTitulo();
    const factura = facturaParaPlantilla();

    const datos = await service.datosPlantilla(
      factura as never,
      copropiedadBase({ name: 'Conjunto X', taxId: '900999999' }) as never,
      { referencia: null, totalAnticipos: 0 },
    );

    expect(datos.emisor).toEqual({
      nombre: 'Conjunto X',
      nit: '900999999',
      digitoVerificacion: '7',
      direccion: 'Calle 1 # 2-3',
      ciudad: 'Bogotá',
      telefono: '6011234567',
      email: 'admin@alcazares.com',
      mostrarLogo: true,
    });
  });

  it('copia titular desde titularDe(factura.holder) — duplicado a propósito junto al Factura.titular general', async () => {
    const { service } = construirServicioConTitulo();
    const factura = facturaParaPlantilla();

    const datos = await service.datosPlantilla(
      factura as never,
      copropiedadBase() as never,
      { referencia: null, totalAnticipos: 0 },
    );

    expect(datos.titular).toMatchObject({
      nombre: 'Ana Pérez',
      numeroIdentificacion: '123456',
    });
  });

  it('tieneDescuentoProntoPago es true exactamente cuando totalConDescuento no es null', async () => {
    const { service } = construirServicioConTitulo();
    const facturaConDescuento = facturaParaPlantilla({
      discountAmount: 20000,
      discountDeadline: new Date('2026-09-30'),
    });

    const datos = await service.datosPlantilla(
      facturaConDescuento as never,
      copropiedadBase() as never,
      { referencia: null, totalAnticipos: 0 },
    );

    expect(datos.tieneDescuentoProntoPago).toBe(true);
    expect(datos.totalConDescuento).not.toBeNull();
  });

  it('tieneDescuentoProntoPago es false y totalConDescuento null cuando la factura no ofrece descuento', async () => {
    const { service } = construirServicioConTitulo();
    const factura = facturaParaPlantilla();

    const datos = await service.datosPlantilla(
      factura as never,
      copropiedadBase() as never,
      { referencia: null, totalAnticipos: 0 },
    );

    expect(datos.tieneDescuentoProntoPago).toBe(false);
    expect(datos.totalConDescuento).toBeNull();
  });

  it('usa el título y la resolución exactos que devuelve TituloDocumentoService.resolverFactura', async () => {
    const resolucionResuelta = {
      numero: 'RES-2026-001',
      nombreVisible: null,
      prefijo: 'CONJ-2026',
      rangoDesde: 1,
      rangoHasta: 5000,
      vigenteDesde: '2026-01-01T00:00:00.000Z',
      vigenteHasta: null,
    };
    const { service } = construirServicioConTitulo({
      titulo: 'Cobro Expensas Comunes',
      resolucion: resolucionResuelta,
    });
    const factura = facturaParaPlantilla();

    const datos = await service.datosPlantilla(
      factura as never,
      copropiedadBase() as never,
      { referencia: null, totalAnticipos: 0 },
    );

    expect(datos.tituloDocumento).toBe('Cobro Expensas Comunes');
    expect(datos.resolucion).toEqual(resolucionResuelta);
  });
});

describe('FacturasService.datosPlantillaPreliminar', () => {
  const loteBase = (over: Record<string, unknown> = {}) => ({
    earlyPaymentDiscount: 0,
    earlyPaymentDiscountFixedValue: 0,
    discountDeadline: new Date('2026-09-30'),
    ...over,
  });

  const preliminarBase = (over: Record<string, unknown> = {}) => ({
    holder: {
      name: 'Carlos Ruiz',
      identificationType: 'CC',
      identificationNumber: '987654',
      identificationVerificationDigit: null,
      address: null,
      city: null,
      email: null,
    },
    lines: [
      {
        conceptoId: { toString: () => 'con-1' },
        conceptName: 'Administración',
        conceptKind: 'administracion',
        baseAmount: 500000,
        taxRate: 0,
        taxAmount: 0,
        totalAmount: 500000,
        balanceBefore: 0,
        balanceAfter: 500000,
      },
    ],
    ...over,
  });

  it('usa literalmente "Prefactura" como tituloDocumento, y NUNCA llama a TituloDocumentoService', () => {
    const { service, tituloDocumento } = construirServicioConTitulo();

    const datos = service.datosPlantillaPreliminar(
      preliminarBase() as never,
      loteBase() as never,
      copropiedadBase() as never,
    );

    expect(datos.tituloDocumento).toBe('Prefactura');
    expect(tituloDocumento.resolverFactura).not.toHaveBeenCalled();
    expect(tituloDocumento.resolverGenerico).not.toHaveBeenCalled();
  });

  it('resolucion siempre es null en una Prefactura — no hay nada frozen que mostrar todavía', () => {
    const { service } = construirServicioConTitulo();

    const datos = service.datosPlantillaPreliminar(
      preliminarBase() as never,
      loteBase() as never,
      copropiedadBase() as never,
    );

    expect(datos.resolucion).toBeNull();
  });

  it('arma emisor y titular igual que datosPlantilla', () => {
    const { service } = construirServicioConTitulo();

    const datos = service.datosPlantillaPreliminar(
      preliminarBase() as never,
      loteBase() as never,
      copropiedadBase({ name: 'Conjunto Y' }) as never,
    );

    expect(datos.emisor.nombre).toBe('Conjunto Y');
    expect(datos.titular).toMatchObject({
      nombre: 'Carlos Ruiz',
      numeroIdentificacion: '987654',
    });
  });
});

describe('FacturasService.guardarPrintSnapshot', () => {
  it('hace un $set de printSnapshot sobre la factura indicada, con exactamente el datos recibido', async () => {
    const facturaId = new Types.ObjectId();
    const updateOne = jest.fn(() => ({ exec: () => Promise.resolve({}) }));
    const service = new FacturasService(
      { updateOne } as never,
      modeloSaldoTotalDocumento([]) as never,
      modeloCarteraPorDocumento([]) as never,
      modeloVacio() as never,
      modeloVacio() as never,
      modeloVacio() as never,
      tenantQueDevuelve(COP),
    );

    const datos = { tituloDocumento: 'Cobro Expensas Comunes' };
    await service.guardarPrintSnapshot(facturaId, datos as never);

    expect(updateOne).toHaveBeenCalledWith(
      { _id: facturaId },
      { $set: { printSnapshot: datos } },
    );
  });
});

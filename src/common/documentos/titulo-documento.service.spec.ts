import { Types } from 'mongoose';
import { TituloDocumentoService } from './titulo-documento.service';

const COP = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const modeloConsecutivos = (
  filas: { code: string; displayName: string | null }[],
) => ({
  findOne: jest.fn((filtro: Filtro) => ({
    exec: () =>
      Promise.resolve(filas.find((f) => f.code === filtro.code) ?? null),
  })),
});

const modeloResoluciones = (
  filas: {
    _id: Types.ObjectId;
    displayName: string | null;
    resolutionNumber: string;
    prefix: string;
    rangeFrom: number;
    rangeTo: number;
    validFrom: Date;
    validUntil: Date | null;
  }[],
) => ({
  findById: jest.fn((id: Types.ObjectId) => ({
    exec: () => Promise.resolve(filas.find((f) => f._id.equals(id)) ?? null),
  })),
});

describe('TituloDocumentoService.resolverGenerico', () => {
  it('devuelve displayName cuando el ConsecutivoDocumento lo tiene configurado', async () => {
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { code: 'RC', displayName: 'Comprobante de Ingreso' },
      ]) as never,
      modeloResoluciones([]) as never,
    );

    const titulo = await service.resolverGenerico('RC', COP);

    expect(titulo).toBe('Comprobante de Ingreso');
  });

  it('cae al literal por defecto de cada tipo cuando no hay fila o displayName es null', async () => {
    const service = new TituloDocumentoService(
      modeloConsecutivos([]) as never,
      modeloResoluciones([]) as never,
    );

    expect(await service.resolverGenerico('RC', COP)).toBe('Recibo de Caja');
    expect(await service.resolverGenerico('NC', COP)).toBe('Nota de Crédito');
    expect(await service.resolverGenerico('ND', COP)).toBe('Nota de Débito');
    expect(await service.resolverGenerico('NT', COP)).toBe('Nota Contable');
    expect(await service.resolverGenerico('NA', COP)).toBe('Nota de Anticipo');
  });
});

describe('TituloDocumentoService.resolverFactura', () => {
  it('sin resolucionId, usa el displayName del ConsecutivoDocumento FV y no arma resolución', async () => {
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { code: 'FV', displayName: 'Factura de Venta' },
      ]) as never,
      modeloResoluciones([]) as never,
    );

    const { titulo, resolucion } = await service.resolverFactura(
      COP,
      null,
      'CONJ-2026',
    );

    expect(titulo).toBe('Factura de Venta');
    expect(resolucion).toBeNull();
  });

  it('sin resolucionId ni displayName configurado, cae a "Cobro Expensas Comunes"', async () => {
    const service = new TituloDocumentoService(
      modeloConsecutivos([]) as never,
      modeloResoluciones([]) as never,
    );

    const { titulo, resolucion } = await service.resolverFactura(
      COP,
      null,
      'CONJ-2026',
    );

    expect(titulo).toBe('Cobro Expensas Comunes');
    expect(resolucion).toBeNull();
  });

  it('con resolucionId, busca ESA resolución específica por id — nunca la activa hoy', async () => {
    const resolucionVieja = new Types.ObjectId();
    const resoluciones = modeloResoluciones([
      {
        _id: resolucionVieja,
        displayName: 'Cobro Antiguo',
        resolutionNumber: 'RES-2024-001',
        prefix: 'OLD-2024',
        rangeFrom: 1,
        rangeTo: 1000,
        validFrom: new Date('2024-01-01'),
        validUntil: new Date('2024-12-31'),
      },
    ]);
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { code: 'FV', displayName: 'Cobro Actual (la resolución de hoy)' },
      ]) as never,
      resoluciones as never,
    );

    const { titulo, resolucion } = await service.resolverFactura(
      COP,
      resolucionVieja,
      'CONJ-2026-1041',
    );

    expect(resoluciones.findById).toHaveBeenCalledWith(resolucionVieja);
    // El título viene de LA RESOLUCIÓN CONGELADA, nunca del consecutivo FV
    // "actual" — aunque este último tenga su propio displayName.
    expect(titulo).toBe('Cobro Antiguo');
    expect(resolucion).toEqual({
      numero: 'RES-2024-001',
      nombreVisible: 'Cobro Antiguo',
      // El prefijo es el de LA FACTURA, nunca el de la resolución.
      prefijo: 'CONJ-2026-1041',
      rangoDesde: 1,
      rangoHasta: 1000,
      vigenteDesde: new Date('2024-01-01').toISOString(),
      vigenteHasta: new Date('2024-12-31').toISOString(),
    });
  });

  it('la resolución congelada sin displayName propio cae al displayName del consecutivo FV, nunca al literal duro directamente', async () => {
    const resolucionId = new Types.ObjectId();
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { code: 'FV', displayName: 'Cobro Expensas (config)' },
      ]) as never,
      modeloResoluciones([
        {
          _id: resolucionId,
          displayName: null,
          resolutionNumber: 'RES-2026-002',
          prefix: 'CONJ-2026',
          rangeFrom: 1,
          rangeTo: 5000,
          validFrom: new Date('2026-01-01'),
          validUntil: null,
        },
      ]) as never,
    );

    const { titulo, resolucion } = await service.resolverFactura(
      COP,
      resolucionId,
      'CONJ-2026-1041',
    );

    expect(titulo).toBe('Cobro Expensas (config)');
    expect(resolucion?.nombreVisible).toBeNull();
    expect(resolucion?.vigenteHasta).toBeNull();
  });

  it('con resolucionId que ya no existe (nunca esperado, pero no debe romper), cae al camino sin resolución', async () => {
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { code: 'FV', displayName: 'Cobro Expensas' },
      ]) as never,
      modeloResoluciones([]) as never,
    );

    const { titulo, resolucion } = await service.resolverFactura(
      COP,
      new Types.ObjectId(),
      'CONJ-2026',
    );

    expect(titulo).toBe('Cobro Expensas');
    expect(resolucion).toBeNull();
  });
});

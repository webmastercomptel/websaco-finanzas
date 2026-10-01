import { Types } from 'mongoose';
import { TituloDocumentoService } from './titulo-documento.service';

const COP = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const modeloConsecutivos = (
  filas: { codigo: string; nombreDocumento: string | null }[],
) => ({
  findOne: jest.fn((filtro: Filtro) => ({
    exec: () =>
      Promise.resolve(filas.find((f) => f.codigo === filtro.codigo) ?? null),
  })),
});

const modeloResoluciones = (
  filas: {
    _id: Types.ObjectId;
    copropiedadId: Types.ObjectId;
    nombreDocumento: string | null;
    numeroResolucion: string;
    prefijo: string;
    rangoDesde: number;
    rangoHasta: number;
    vigenciaDesde: Date;
    vigenciaHasta: Date | null;
  }[],
) => ({
  // Tenant-scoped on purpose — see "The tenancy law" in backend/CLAUDE.md.
  // A bare `findById` would return a `ResolucionFacturacion` belonging to a
  // DIFFERENT coproperty when `resolucionId` is stale/forged/cross-tenant.
  findOne: jest.fn(
    (filtro: { _id: Types.ObjectId; copropiedadId: Types.ObjectId }) => ({
      exec: () =>
        Promise.resolve(
          filas.find(
            (f) =>
              f._id.equals(filtro._id) &&
              f.copropiedadId.equals(filtro.copropiedadId),
          ) ?? null,
        ),
    }),
  ),
});

describe('TituloDocumentoService.resolverGenerico', () => {
  it('devuelve nombreDocumento cuando el ConsecutivoDocumento lo tiene configurado', async () => {
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { codigo: 'RC', nombreDocumento: 'Comprobante de Ingreso' },
      ]) as never,
      modeloResoluciones([]) as never,
    );

    const titulo = await service.resolverGenerico('RC', COP);

    expect(titulo).toBe('Comprobante de Ingreso');
  });

  it('cae al literal por defecto de cada tipo cuando no hay fila o nombreDocumento es null', async () => {
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
  it('sin resolucionId, usa el nombreDocumento del ConsecutivoDocumento FV y no arma resolución', async () => {
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { codigo: 'FV', nombreDocumento: 'Factura de Venta' },
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

  it('sin resolucionId ni nombreDocumento configurado, cae a "Cobro Expensas Comunes"', async () => {
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
        copropiedadId: COP,
        nombreDocumento: 'Cobro Antiguo',
        numeroResolucion: 'RES-2024-001',
        prefijo: 'OLD-2024',
        rangoDesde: 1,
        rangoHasta: 1000,
        vigenciaDesde: new Date('2024-01-01'),
        vigenciaHasta: new Date('2024-12-31'),
      },
    ]);
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        {
          codigo: 'FV',
          nombreDocumento: 'Cobro Actual (la resolución de hoy)',
        },
      ]) as never,
      resoluciones as never,
    );

    const { titulo, resolucion } = await service.resolverFactura(
      COP,
      resolucionVieja,
      'CONJ-2026-1041',
    );

    expect(resoluciones.findOne).toHaveBeenCalledWith({
      _id: resolucionVieja,
      copropiedadId: COP,
    });
    // El título viene de LA RESOLUCIÓN CONGELADA, nunca del consecutivo FV
    // "actual" — aunque este último tenga su propio nombreDocumento.
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

  it('la resolución congelada sin nombreDocumento propio cae al nombreDocumento del consecutivo FV, nunca al literal duro directamente', async () => {
    const resolucionId = new Types.ObjectId();
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { codigo: 'FV', nombreDocumento: 'Cobro Expensas (config)' },
      ]) as never,
      modeloResoluciones([
        {
          _id: resolucionId,
          copropiedadId: COP,
          nombreDocumento: null,
          numeroResolucion: 'RES-2026-002',
          prefijo: 'CONJ-2026',
          rangoDesde: 1,
          rangoHasta: 5000,
          vigenciaDesde: new Date('2026-01-01'),
          vigenciaHasta: null,
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
        { codigo: 'FV', nombreDocumento: 'Cobro Expensas' },
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

  it('una resolución que existe pero pertenece a OTRA coproperty no se devuelve — tenancy law: cae al camino sin resolución, igual que "no existe", nunca filtra de qué tenant es', async () => {
    const OTRA_COP = new Types.ObjectId();
    const resolucionDeOtroTenant = new Types.ObjectId();
    const resoluciones = modeloResoluciones([
      {
        _id: resolucionDeOtroTenant,
        copropiedadId: OTRA_COP,
        nombreDocumento: 'Resolución de otra coproperty',
        numeroResolucion: 'RES-2026-999',
        prefijo: 'OTRA-2026',
        rangoDesde: 1,
        rangoHasta: 100,
        vigenciaDesde: new Date('2026-01-01'),
        vigenciaHasta: null,
      },
    ]);
    const service = new TituloDocumentoService(
      modeloConsecutivos([
        { codigo: 'FV', nombreDocumento: 'Cobro Expensas' },
      ]) as never,
      resoluciones as never,
    );

    const { titulo, resolucion } = await service.resolverFactura(
      COP,
      resolucionDeOtroTenant,
      'CONJ-2026',
    );

    expect(resoluciones.findOne).toHaveBeenCalledWith({
      _id: resolucionDeOtroTenant,
      copropiedadId: COP,
    });
    // Same outcome as "no existe" — never leaks the other tenant's title.
    expect(titulo).toBe('Cobro Expensas');
    expect(resolucion).toBeNull();
  });
});

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ReiniciarCicloService } from './reiniciar-ciclo.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();

const copropiedad = (over: Record<string, unknown> = {}) => ({
  _id: COP,
  code: '0001',
  ...over,
});

const tenantQueDevuelve = (id: Types.ObjectId): TenantContextService =>
  ({ resolveCoPropertyId: () => id }) as unknown as TenantContextService;

/** Builds a minimal, hand-rolled mock for every model the service injects.
 *  Each field can be overridden per test; unset ones return the harmless
 *  default a happy path needs (no facturas, no cross-references). */
const makeModelos = (over: {
  copropiedad?: unknown;
  facturaIds?: string[];
  notaCreditoRef?: boolean;
  aplicacionRef?: boolean;
  resolucionActiva?: Record<string, unknown> | null;
  deletedCounts?: Partial<{
    lotes: number;
    facturas: number;
    asientos: number;
    saldos: number;
  }>;
}) => {
  const counts = {
    lotes: 0,
    facturas: 0,
    asientos: 0,
    saldos: 0,
    ...over.deletedCounts,
  };

  const copropiedades = {
    findById: jest.fn(() => ({
      exec: () =>
        Promise.resolve(
          'copropiedad' in over ? over.copropiedad : copropiedad(),
        ),
    })),
  };

  const facturas = {
    find: jest.fn(() => ({
      distinct: () => ({
        exec: () => Promise.resolve(over.facturaIds ?? []),
      }),
    })),
    deleteMany: jest.fn(() => ({
      exec: () => Promise.resolve({ deletedCount: counts.facturas }),
    })),
  };

  const lotes = {
    deleteMany: jest.fn(() => ({
      exec: () => Promise.resolve({ deletedCount: counts.lotes }),
    })),
  };

  const asientosFiltros: Record<string, unknown>[] = [];
  const asientos = {
    deleteMany: jest.fn((filtro: Record<string, unknown>) => {
      asientosFiltros.push(filtro);
      return { exec: () => Promise.resolve({ deletedCount: counts.asientos }) };
    }),
    filtros: asientosFiltros,
  };

  const saldos = {
    deleteMany: jest.fn(() => ({
      exec: () => Promise.resolve({ deletedCount: counts.saldos }),
    })),
  };

  const consecutivoLote = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const consecutivoDocumento = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const resoluciones = {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(over.resolucionActiva ?? null),
    })),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const notasCredito = {
    exists: jest.fn(() => Promise.resolve(over.notaCreditoRef ?? false)),
  };
  const aplicaciones = {
    exists: jest.fn(() => Promise.resolve(over.aplicacionRef ?? false)),
  };

  return {
    copropiedades,
    facturas,
    lotes,
    asientos,
    saldos,
    consecutivoLote,
    consecutivoDocumento,
    resoluciones,
    notasCredito,
    aplicaciones,
  };
};

const makeService = (
  modelos: ReturnType<typeof makeModelos>,
  coPropertyId: Types.ObjectId = COP,
) =>
  new ReiniciarCicloService(
    modelos.copropiedades as never,
    modelos.facturas as never,
    modelos.lotes as never,
    modelos.asientos as never,
    modelos.saldos as never,
    modelos.consecutivoLote as never,
    modelos.consecutivoDocumento as never,
    modelos.resoluciones as never,
    modelos.notasCredito as never,
    modelos.aplicaciones as never,
    tenantQueDevuelve(coPropertyId),
  );

describe('ReiniciarCicloService.reiniciar', () => {
  it('rechaza cuando la copropiedad activa no es la de pruebas (código distinto de 0001)', async () => {
    const modelos = makeModelos({
      copropiedad: copropiedad({ code: 'COP-002' }),
    });
    const service = makeService(modelos);

    await expect(service.reiniciar()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(modelos.facturas.deleteMany).not.toHaveBeenCalled();
  });

  it('rechaza cuando la copropiedad no existe', async () => {
    const modelos = makeModelos({ copropiedad: null });
    const service = makeService(modelos);

    await expect(service.reiniciar()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rechaza sin borrar nada si hay una Nota Crédito contra una factura de esta copropiedad', async () => {
    const modelos = makeModelos({
      facturaIds: ['fac-1'],
      notaCreditoRef: true,
    });
    const service = makeService(modelos);

    await expect(service.reiniciar()).rejects.toBeInstanceOf(ConflictException);
    expect(modelos.facturas.deleteMany).not.toHaveBeenCalled();
    expect(modelos.lotes.deleteMany).not.toHaveBeenCalled();
  });

  it('rechaza sin borrar nada si hay un Recibo aplicado contra una factura de esta copropiedad', async () => {
    const modelos = makeModelos({
      facturaIds: ['fac-1'],
      aplicacionRef: true,
    });
    const service = makeService(modelos);

    await expect(service.reiniciar()).rejects.toBeInstanceOf(ConflictException);
    expect(modelos.facturas.deleteMany).not.toHaveBeenCalled();
  });

  it('borra lotes, facturas, asientos y saldos, y devuelve los conteos', async () => {
    const modelos = makeModelos({
      deletedCounts: { lotes: 2, facturas: 5, asientos: 5, saldos: 8 },
    });
    const service = makeService(modelos);

    const resultado = await service.reiniciar();

    expect(modelos.facturas.deleteMany).toHaveBeenCalled();
    expect(modelos.lotes.deleteMany).toHaveBeenCalled();
    expect(resultado).toEqual({
      lotesEliminados: 2,
      facturasEliminadas: 5,
      asientosEliminados: 5,
      saldosEliminados: 8,
    });
  });

  it('solo borra asientos de origen Factura (facturaId no nulo), nunca de Recibos/Notas', async () => {
    const modelos = makeModelos({});
    const service = makeService(modelos);

    await service.reiniciar();

    expect(modelos.asientos.filtros[0]).toMatchObject({
      coPropertyId: COP,
      facturaId: { $ne: null },
    });
  });

  it('reinicia a 1 el consecutivo de lote y el de FV', async () => {
    const modelos = makeModelos({});
    const service = makeService(modelos);

    await service.reiniciar();

    // 0, no 1: siguienteLote/siguienteDocumento incrementan antes de leer
    // (`{ new: true }`), así que dejar el consecutivo en 1 haría que el
    // próximo número emitido fuera 2, no 1.
    expect(modelos.consecutivoLote.updateOne).toHaveBeenCalledWith(
      { coPropertyId: COP },
      { $set: { nextNumber: 0 } },
    );
    expect(modelos.consecutivoDocumento.updateOne).toHaveBeenCalledWith(
      { coPropertyId: COP, category: 'FV' },
      { $set: { nextNumber: 0 } },
    );
  });

  it('si hay una resolución DIAN activa, reinicia su nextNumber al rangeFrom', async () => {
    const modelos = makeModelos({
      resolucionActiva: { _id: 'res-1', rangeFrom: 1000 },
    });
    const service = makeService(modelos);

    await service.reiniciar();

    expect(modelos.resoluciones.updateOne).toHaveBeenCalledWith(
      { _id: 'res-1' },
      { $set: { nextNumber: 1000 } },
    );
  });

  it('sin resolución DIAN activa, no intenta actualizar ninguna', async () => {
    const modelos = makeModelos({ resolucionActiva: null });
    const service = makeService(modelos);

    await service.reiniciar();

    expect(modelos.resoluciones.updateOne).not.toHaveBeenCalled();
  });

  it('una copropiedad de pruebas sin facturas se reinicia sin lanzar', async () => {
    const modelos = makeModelos({ facturaIds: [] });
    const service = makeService(modelos);

    await expect(service.reiniciar()).resolves.toBeDefined();
    expect(modelos.notasCredito.exists).not.toHaveBeenCalled();
    expect(modelos.aplicaciones.exists).not.toHaveBeenCalled();
  });
});

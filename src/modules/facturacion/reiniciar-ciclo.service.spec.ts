import { ForbiddenException } from '@nestjs/common';
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

const deleteManyMock = (deletedCount: number) => ({
  deleteMany: jest.fn(() => ({
    exec: () => Promise.resolve({ deletedCount }),
  })),
});

/** Builds a minimal, hand-rolled mock for every model the service injects.
 *  Each field can be overridden per test; unset ones return the harmless
 *  default a happy path needs (0 deleted, no active resolución). */
const makeModelos = (over: {
  copropiedad?: unknown;
  resolucionActiva?: Record<string, unknown> | null;
  deletedCounts?: Partial<{
    lotes: number;
    facturas: number;
    asientos: number;
    saldos: number;
    recibos: number;
    loteRecibos: number;
    notasCredito: number;
    notasDebito: number;
    notasAnticipo: number;
    notasContables: number;
    aplicaciones: number;
    carteraPorDocumento: number;
    saldosDocumentoOrigen: number;
  }>;
}) => {
  const counts = {
    lotes: 0,
    facturas: 0,
    asientos: 0,
    saldos: 0,
    recibos: 0,
    loteRecibos: 0,
    notasCredito: 0,
    notasDebito: 0,
    notasAnticipo: 0,
    notasContables: 0,
    aplicaciones: 0,
    carteraPorDocumento: 0,
    saldosDocumentoOrigen: 0,
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

  const facturas = deleteManyMock(counts.facturas);
  const lotes = deleteManyMock(counts.lotes);
  const asientos = deleteManyMock(counts.asientos);
  const saldos = deleteManyMock(counts.saldos);
  const recibos = deleteManyMock(counts.recibos);
  const loteRecibos = deleteManyMock(counts.loteRecibos);
  const notasCredito = deleteManyMock(counts.notasCredito);
  const notasDebito = deleteManyMock(counts.notasDebito);
  const notasAnticipo = deleteManyMock(counts.notasAnticipo);
  const notasContables = deleteManyMock(counts.notasContables);
  const aplicaciones = deleteManyMock(counts.aplicaciones);
  const carteraPorDocumento = deleteManyMock(counts.carteraPorDocumento);
  const saldosDocumentoOrigen = deleteManyMock(counts.saldosDocumentoOrigen);

  const consecutivoLote = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const consecutivoDocumento = {
    updateMany: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const consecutivoLoteRecibos = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const resoluciones = {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(over.resolucionActiva ?? null),
    })),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };

  return {
    copropiedades,
    facturas,
    lotes,
    asientos,
    saldos,
    consecutivoLote,
    consecutivoDocumento,
    consecutivoLoteRecibos,
    resoluciones,
    notasCredito,
    aplicaciones,
    recibos,
    loteRecibos,
    notasDebito,
    notasAnticipo,
    notasContables,
    carteraPorDocumento,
    saldosDocumentoOrigen,
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
    modelos.carteraPorDocumento as never,
    modelos.saldosDocumentoOrigen as never,
    modelos.consecutivoLote as never,
    modelos.consecutivoDocumento as never,
    modelos.resoluciones as never,
    modelos.notasCredito as never,
    modelos.aplicaciones as never,
    modelos.recibos as never,
    modelos.loteRecibos as never,
    modelos.consecutivoLoteRecibos as never,
    modelos.notasDebito as never,
    modelos.notasAnticipo as never,
    modelos.notasContables as never,
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

  it('borra TODO documento financiero de la copropiedad y devuelve los conteos', async () => {
    const modelos = makeModelos({
      deletedCounts: {
        lotes: 2,
        facturas: 5,
        asientos: 12,
        saldos: 8,
        recibos: 3,
        loteRecibos: 7,
        notasCredito: 1,
        notasDebito: 2,
        notasAnticipo: 1,
        notasContables: 4,
        aplicaciones: 6,
      },
    });
    const service = makeService(modelos);

    const resultado = await service.reiniciar();

    expect(modelos.facturas.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.lotes.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.recibos.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.loteRecibos.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.notasCredito.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.notasDebito.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.notasAnticipo.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.notasContables.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.aplicaciones.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(resultado).toEqual({
      lotesEliminados: 2,
      facturasEliminadas: 5,
      recibosEliminados: 3,
      loteRecibosEliminados: 7,
      notasCreditoEliminadas: 1,
      notasDebitoEliminadas: 2,
      notasAnticipoEliminadas: 1,
      notasContablesEliminadas: 4,
      aplicacionesEliminadas: 6,
      asientosEliminados: 12,
      saldosEliminados: 8,
      carteraPorDocumentoEliminada: 0,
      saldosDocumentoOrigenEliminados: 0,
    });
  });

  it('borra TODOS los asientos contables, sin filtrar por tipo de ancla', async () => {
    const modelos = makeModelos({});
    const service = makeService(modelos);

    await service.reiniciar();

    // Antes solo se borraban los asientos anclados a Factura
    // (facturaId: {$ne: null}) — ahora se borra todo, porque Recibos/Notas
    // (los otros anclajes posibles) también se borran en esta misma pasada.
    expect(modelos.asientos.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
  });

  it('borra también CarteraPorDocumento y SaldoDocumentoOrigen, los dos libros de cartera por documento', async () => {
    const modelos = makeModelos({
      deletedCounts: { carteraPorDocumento: 9, saldosDocumentoOrigen: 4 },
    });
    const service = makeService(modelos);

    const resultado = await service.reiniciar();

    expect(modelos.carteraPorDocumento.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.saldosDocumentoOrigen.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(resultado.carteraPorDocumentoEliminada).toBe(9);
    expect(resultado.saldosDocumentoOrigenEliminados).toBe(4);
  });

  it('reinicia a 0 el consecutivo de lote y TODOS los consecutivos de documento de la copropiedad', async () => {
    const modelos = makeModelos({});
    const service = makeService(modelos);

    await service.reiniciar();

    // 0, no 1: siguienteLote/siguienteDocumento incrementan antes de leer
    // (`{ returnDocument: 'after' }`), así que dejar el consecutivo en 1 haría que el
    // próximo número emitido fuera 2, no 1.
    expect(modelos.consecutivoLote.updateOne).toHaveBeenCalledWith(
      { coPropertyId: COP },
      { $set: { nextNumber: 0 } },
    );
    // updateMany sin filtro de category/code — todo código configurado
    // (RC, NC, ND, NA, ...) reinicia junto, porque todo tipo de documento
    // se borró en esta misma pasada.
    expect(modelos.consecutivoDocumento.updateMany).toHaveBeenCalledWith(
      { coPropertyId: COP },
      { $set: { nextNumber: 0 } },
    );
  });

  it('borra los lotes de recibos en curso y reinicia su propio consecutivo', async () => {
    // Regresión: `LoteRecibosSchema` permite a lo sumo un lote en
    // 'borrador'/'cargado' por copropiedad — dejar uno vivo tras el reinicio
    // bloqueaba crear uno nuevo (índice único), aunque Recibos/Facturas ya
    // hubieran sido borrados.
    const modelos = makeModelos({ deletedCounts: { loteRecibos: 1 } });
    const service = makeService(modelos);

    const resultado = await service.reiniciar();

    expect(modelos.loteRecibos.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
    });
    expect(modelos.consecutivoLoteRecibos.updateOne).toHaveBeenCalledWith(
      { coPropertyId: COP },
      { $set: { nextNumber: 0 } },
    );
    expect(resultado.loteRecibosEliminados).toBe(1);
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

  it('una copropiedad de pruebas sin ningún documento se reinicia sin lanzar', async () => {
    const modelos = makeModelos({});
    const service = makeService(modelos);

    await expect(service.reiniciar()).resolves.toBeDefined();
  });
});

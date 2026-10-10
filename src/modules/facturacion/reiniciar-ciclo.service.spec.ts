import { ConflictException, Logger } from '@nestjs/common';
import { SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { ReiniciarCicloService } from './reiniciar-ciclo.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import { ConsecutivoLote } from '../../database/schemas/facturacion/consecutivo-lote.schema';
import { ConsecutivoLoteRecibos } from '../../database/schemas/recibos/consecutivo-lote-recibos.schema';
import { ConsecutivoSaldoInicial } from '../../database/schemas/saldos-iniciales/consecutivo-saldo-inicial.schema';
import { ConsecutivoSaldoInicialAnticipo } from '../../database/schemas/saldos-iniciales/consecutivo-saldo-inicial-anticipo.schema';
import { ConsecutivoDocumento } from '../../database/schemas/numeracion/consecutivo-documento.schema';
import { ConsecutivoLoteContabilidad } from '../../database/schemas/contabilidad/consecutivo-lote-contabilidad.schema';
import { ResolucionFacturacion } from '../../database/schemas/numeracion/resolucion-facturacion.schema';

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId().toString();
const PREFIJO_PDFS = `documentos-generados/${COP.toString()}/`;

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
  resolucionActiva?: Record<string, unknown> | null;
  /** A LoteFacturacion with `progreso` non-null (consolidación running). */
  loteConsolidando?: Record<string, unknown> | null;
  /** Jobs the aplicación-de-lotes-de-recibos queue reports as unfinished. */
  trabajosAplicacion?: { data: { copropiedadId: string } }[];
  /** Makes `getJobs` reject (queue/Redis unreachable). */
  colaFalla?: boolean;
  storageFalla?: boolean;
  auditoriaFalla?: boolean;
  archivosPdf?: number;
  archivosFallidos?: number;
  /** The single `ProgresoImportacion` row present in the collection. */
  importacion?: { tipo: string; updatedAt: Date };
  deletedCounts?: Partial<{
    presentaciones: number;
    progresosImportacion: number;
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
    lotesContabilidad: number;
    saldosIniciales: number;
    lotesSaldoInicial: number;
    saldoTotalDocumento: number;
    saldosInicialesAnticipo: number;
    lotesSaldoInicialAnticipo: number;
  }>;
}) => {
  const counts = {
    presentaciones: 0,
    progresosImportacion: 0,
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
    lotesContabilidad: 0,
    saldosIniciales: 0,
    lotesSaldoInicial: 0,
    saldoTotalDocumento: 0,
    saldosInicialesAnticipo: 0,
    lotesSaldoInicialAnticipo: 0,
    ...over.deletedCounts,
  };

  const facturas = deleteManyMock(counts.facturas);
  const lotes = {
    ...deleteManyMock(counts.lotes),
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(over.loteConsolidando ?? null),
    })),
  };
  const presentaciones = deleteManyMock(counts.presentaciones);
  const progresosImportacion = {
    ...deleteManyMock(counts.progresosImportacion),
    // Mimics Mongo applying the guard's filter to the one row the test seeds:
    // it matches only when the tipo is in `$in` and `updatedAt >= $gte`.
    findOne: jest.fn(
      (filtro: { tipo: { $in: string[] }; updatedAt: { $gte: Date } }) => ({
        exec: () => {
          const fila = over.importacion;
          const coincide =
            !!fila &&
            filtro.tipo.$in.includes(fila.tipo) &&
            fila.updatedAt >= filtro.updatedAt.$gte;
          return Promise.resolve(coincide ? fila : null);
        },
      }),
    ),
  };
  const cuentas = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ nombreCompleto: 'Admin Plataforma' }),
    })),
  };
  const copropiedades = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ codigo: '0001', nombre: 'Edificio Sol' }),
    })),
  };
  const storage = {
    eliminarPrefijo: jest.fn(() =>
      over.storageFalla
        ? Promise.reject(new Error('bucket caído'))
        : Promise.resolve({
            eliminados: over.archivosPdf ?? 0,
            fallidos: over.archivosFallidos ?? 0,
          }),
    ),
  };
  const auditoria = {
    registrar: jest.fn(() =>
      over.auditoriaFalla
        ? Promise.reject(new Error('audit caída'))
        : Promise.resolve(),
    ),
  };
  const colaAplicacionLoteRecibos = {
    getJobs: jest.fn(() =>
      over.colaFalla
        ? Promise.reject(new Error('redis caído'))
        : Promise.resolve(over.trabajosAplicacion ?? []),
    ),
  };
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
  const lotesContabilidad = deleteManyMock(counts.lotesContabilidad);
  const saldosIniciales = deleteManyMock(counts.saldosIniciales);
  const lotesSaldoInicial = deleteManyMock(counts.lotesSaldoInicial);
  const saldoTotalDocumento = deleteManyMock(counts.saldoTotalDocumento);
  const saldosInicialesAnticipo = deleteManyMock(
    counts.saldosInicialesAnticipo,
  );
  const lotesSaldoInicialAnticipo = deleteManyMock(
    counts.lotesSaldoInicialAnticipo,
  );

  const consecutivoLote = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const consecutivoDocumento = {
    updateMany: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const consecutivoLoteRecibos = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const consecutivoLoteContabilidad = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const consecutivoSaldoInicial = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const consecutivoSaldoInicialAnticipo = {
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };
  const resoluciones = {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve(over.resolucionActiva ?? null),
    })),
    updateOne: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
  };

  return {
    presentaciones,
    progresosImportacion,
    cuentas,
    copropiedades,
    storage,
    auditoria,
    colaAplicacionLoteRecibos,
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
    lotesContabilidad,
    consecutivoLoteContabilidad,
    saldosIniciales,
    lotesSaldoInicial,
    consecutivoSaldoInicial,
    saldoTotalDocumento,
    saldosInicialesAnticipo,
    lotesSaldoInicialAnticipo,
    consecutivoSaldoInicialAnticipo,
  };
};

const makeService = (
  modelos: ReturnType<typeof makeModelos>,
  copropiedadId: Types.ObjectId = COP,
) =>
  new ReiniciarCicloService(
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
    modelos.lotesContabilidad as never,
    modelos.consecutivoLoteContabilidad as never,
    modelos.saldosIniciales as never,
    modelos.lotesSaldoInicial as never,
    modelos.consecutivoSaldoInicial as never,
    modelos.saldoTotalDocumento as never,
    modelos.saldosInicialesAnticipo as never,
    modelos.lotesSaldoInicialAnticipo as never,
    modelos.consecutivoSaldoInicialAnticipo as never,
    modelos.presentaciones as never,
    modelos.progresosImportacion as never,
    modelos.cuentas as never,
    modelos.copropiedades as never,
    modelos.storage as never,
    modelos.auditoria as never,
    modelos.colaAplicacionLoteRecibos as never,
    tenantQueDevuelve(copropiedadId),
  );

describe('ReiniciarCicloService.reiniciar', () => {
  // The best-effort paths log on purpose; keep the test output clean.
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('opera sobre la copropiedad activa del tenant, sin lista de códigos permitidos', async () => {
    const modelos = makeModelos({ deletedCounts: { facturas: 1 } });
    const service = makeService(modelos);

    await expect(service.reiniciar(CUENTA)).resolves.toBeDefined();
    expect(modelos.facturas.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
  });

  it('borra TODO documento financiero de la copropiedad y devuelve los conteos', async () => {
    const modelos = makeModelos({
      archivosPdf: 22,
      deletedCounts: {
        lotes: 1,
        facturas: 2,
        asientos: 3,
        saldos: 4,
        recibos: 5,
        loteRecibos: 6,
        notasCredito: 7,
        notasDebito: 8,
        notasAnticipo: 9,
        notasContables: 10,
        aplicaciones: 11,
        carteraPorDocumento: 12,
        saldosDocumentoOrigen: 13,
        lotesContabilidad: 14,
        saldosIniciales: 15,
        lotesSaldoInicial: 16,
        saldoTotalDocumento: 17,
        saldosInicialesAnticipo: 18,
        lotesSaldoInicialAnticipo: 19,
        presentaciones: 20,
        progresosImportacion: 21,
      },
    });
    const service = makeService(modelos);

    const resultado = await service.reiniciar(CUENTA);

    expect(modelos.facturas.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.lotes.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.recibos.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.loteRecibos.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.notasCredito.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.notasDebito.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.notasAnticipo.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.notasContables.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.aplicaciones.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    // Cada campo con un valor DISTINTO: un cruce en el orden de la
    // desestructuración del servicio haría fallar este test.
    expect(resultado).toEqual({
      lotesEliminados: 1,
      facturasEliminadas: 2,
      asientosEliminados: 3,
      saldosEliminados: 4,
      recibosEliminados: 5,
      loteRecibosEliminados: 6,
      notasCreditoEliminadas: 7,
      notasDebitoEliminadas: 8,
      notasAnticipoEliminadas: 9,
      notasContablesEliminadas: 10,
      aplicacionesEliminadas: 11,
      carteraPorDocumentoEliminada: 12,
      saldosDocumentoOrigenEliminados: 13,
      lotesContabilidadEliminados: 14,
      saldosInicialesEliminados: 15,
      lotesSaldoInicialEliminados: 16,
      saldoTotalDocumentoEliminado: 17,
      saldosInicialesAnticipoEliminados: 18,
      lotesSaldoInicialAnticipoEliminados: 19,
      presentacionesEliminadas: 20,
      progresosImportacionEliminados: 21,
      archivosPdfEliminados: 22,
    });
  });

  it('borra los lotes de "Adición a Contabilidad" y reinicia su propio consecutivo', async () => {
    // Regresión: este servicio se escribió antes de que existiera el módulo
    // de Adición a Contabilidad — sin esto, un reinicio dejaba lotes/números
    // viejos de una corrida anterior mezclados con la siguiente.
    const modelos = makeModelos({ deletedCounts: { lotesContabilidad: 3 } });
    const service = makeService(modelos);

    const resultado = await service.reiniciar(CUENTA);

    expect(modelos.lotesContabilidad.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.consecutivoLoteContabilidad.updateOne).toHaveBeenCalledWith(
      { copropiedadId: COP },
      { $set: { nextNumber: 0 } },
    );
    expect(resultado.lotesContabilidadEliminados).toBe(3);
  });

  it('borra los Saldos Iniciales y sus lotes, y reinicia su propio consecutivo', async () => {
    // Regresión: el reinicio se escribió antes de que existiera el módulo de
    // Saldos Iniciales — sin esto, la "cartera" quedaba en cero pero el
    // documento fuente seguía apareciendo en el listado, y una nueva
    // importación seguía numerando donde iba en vez de reiniciar en 1.
    const modelos = makeModelos({
      deletedCounts: { saldosIniciales: 5, lotesSaldoInicial: 2 },
    });
    const service = makeService(modelos);

    const resultado = await service.reiniciar(CUENTA);

    expect(modelos.saldosIniciales.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.lotesSaldoInicial.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.consecutivoSaldoInicial.updateOne).toHaveBeenCalledWith(
      { copropiedadId: COP },
      { $set: { siguienteNumero: 0 } },
    );
    expect(resultado.saldosInicialesEliminados).toBe(5);
    expect(resultado.lotesSaldoInicialEliminados).toBe(2);
  });

  it('borra los Saldos Iniciales de Anticipo y sus lotes, y reinicia su propio consecutivo', async () => {
    // Regresión: el reinicio se escribió antes de que existiera Saldos
    // Iniciales de Anticipo — sin esto, un anticipo importado sobrevivía al
    // reinicio con su saldo disponible ya en cero (por el borrado sin
    // filtrar de SaldoDocumentoOrigen), quedando huérfano en el listado.
    const modelos = makeModelos({
      deletedCounts: {
        saldosInicialesAnticipo: 3,
        lotesSaldoInicialAnticipo: 1,
      },
    });
    const service = makeService(modelos);

    const resultado = await service.reiniciar(CUENTA);

    expect(modelos.saldosInicialesAnticipo.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.lotesSaldoInicialAnticipo.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(
      modelos.consecutivoSaldoInicialAnticipo.updateOne,
    ).toHaveBeenCalledWith(
      { copropiedadId: COP },
      { $set: { siguienteNumero: 0 } },
    );
    expect(resultado.saldosInicialesAnticipoEliminados).toBe(3);
    expect(resultado.lotesSaldoInicialAnticipoEliminados).toBe(1);
  });

  it('borra SaldoTotalDocumento sin filtrar por tipo, junto con los otros libros por documento', async () => {
    const modelos = makeModelos({
      deletedCounts: { saldoTotalDocumento: 11 },
    });
    const service = makeService(modelos);

    const resultado = await service.reiniciar(CUENTA);

    expect(modelos.saldoTotalDocumento.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(resultado.saldoTotalDocumentoEliminado).toBe(11);
  });

  it('borra TODOS los asientos contables, sin filtrar por tipo de ancla', async () => {
    const modelos = makeModelos({});
    const service = makeService(modelos);

    await service.reiniciar(CUENTA);

    // Antes solo se borraban los asientos anclados a Factura
    // (facturaId: {$ne: null}) — ahora se borra todo, porque Recibos/Notas
    // (los otros anclajes posibles) también se borran en esta misma pasada.
    expect(modelos.asientos.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
  });

  it('borra también CarteraPorDocumento y SaldoDocumentoOrigen, los dos libros de cartera por documento', async () => {
    const modelos = makeModelos({
      deletedCounts: { carteraPorDocumento: 9, saldosDocumentoOrigen: 4 },
    });
    const service = makeService(modelos);

    const resultado = await service.reiniciar(CUENTA);

    expect(modelos.carteraPorDocumento.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.saldosDocumentoOrigen.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(resultado.carteraPorDocumentoEliminada).toBe(9);
    expect(resultado.saldosDocumentoOrigenEliminados).toBe(4);
  });

  it('reinicia a 0 el consecutivo de lote y TODOS los consecutivos de documento de la copropiedad', async () => {
    const modelos = makeModelos({});
    const service = makeService(modelos);

    await service.reiniciar(CUENTA);

    // 0, no 1: siguienteLote/siguienteDocumento incrementan antes de leer
    // (`{ returnDocument: 'after' }`), así que dejar el consecutivo en 1 haría que el
    // próximo número emitido fuera 2, no 1.
    expect(modelos.consecutivoLote.updateOne).toHaveBeenCalledWith(
      { copropiedadId: COP },
      { $set: { siguienteNumero: 0 } },
    );
    // updateMany sin filtro de categoria/codigo — todo código configurado
    // (RC, NC, ND, NA, ...) reinicia junto, porque todo tipo de documento
    // se borró en esta misma pasada.
    expect(modelos.consecutivoDocumento.updateMany).toHaveBeenCalledWith(
      { copropiedadId: COP },
      { $set: { siguienteNumero: 0 } },
    );
  });

  it('borra los lotes de recibos en curso y reinicia su propio consecutivo', async () => {
    // Regresión: `LoteRecibosSchema` permite a lo sumo un lote en
    // 'borrador'/'cargado' por copropiedad — dejar uno vivo tras el reinicio
    // bloqueaba crear uno nuevo (índice único), aunque Recibos/Facturas ya
    // hubieran sido borrados.
    const modelos = makeModelos({ deletedCounts: { loteRecibos: 1 } });
    const service = makeService(modelos);

    const resultado = await service.reiniciar(CUENTA);

    expect(modelos.loteRecibos.deleteMany).toHaveBeenCalledWith({
      copropiedadId: COP,
    });
    expect(modelos.consecutivoLoteRecibos.updateOne).toHaveBeenCalledWith(
      { copropiedadId: COP },
      { $set: { siguienteNumero: 0 } },
    );
    expect(resultado.loteRecibosEliminados).toBe(1);
  });

  it('si hay una resolución DIAN activa, reinicia su siguienteNumero al rangoDesde', async () => {
    const modelos = makeModelos({
      resolucionActiva: { _id: 'res-1', rangoDesde: 1000 },
    });
    const service = makeService(modelos);

    await service.reiniciar(CUENTA);

    expect(modelos.resoluciones.updateOne).toHaveBeenCalledWith(
      { _id: 'res-1' },
      { $set: { siguienteNumero: 1000 } },
    );
  });

  it('sin resolución DIAN activa, no intenta actualizar ninguna', async () => {
    const modelos = makeModelos({ resolucionActiva: null });
    const service = makeService(modelos);

    await service.reiniciar(CUENTA);

    expect(modelos.resoluciones.updateOne).not.toHaveBeenCalled();
  });

  it('una copropiedad de pruebas sin ningún documento se reinicia sin lanzar', async () => {
    const modelos = makeModelos({});
    const service = makeService(modelos);

    await expect(service.reiniciar(CUENTA)).resolves.toBeDefined();
  });

  describe('guarda de concurrencia', () => {
    /** Every collection the service can delete from or rewind. */
    const todoLoQueEscribe = (m: ReturnType<typeof makeModelos>) => [
      m.facturas.deleteMany,
      m.lotes.deleteMany,
      m.asientos.deleteMany,
      m.saldos.deleteMany,
      m.recibos.deleteMany,
      m.loteRecibos.deleteMany,
      m.notasCredito.deleteMany,
      m.notasDebito.deleteMany,
      m.notasAnticipo.deleteMany,
      m.notasContables.deleteMany,
      m.aplicaciones.deleteMany,
      m.carteraPorDocumento.deleteMany,
      m.saldosDocumentoOrigen.deleteMany,
      m.lotesContabilidad.deleteMany,
      m.saldosIniciales.deleteMany,
      m.lotesSaldoInicial.deleteMany,
      m.saldoTotalDocumento.deleteMany,
      m.saldosInicialesAnticipo.deleteMany,
      m.lotesSaldoInicialAnticipo.deleteMany,
      m.presentaciones.deleteMany,
      m.progresosImportacion.deleteMany,
      m.consecutivoLote.updateOne,
      m.consecutivoDocumento.updateMany,
      m.consecutivoLoteRecibos.updateOne,
      m.consecutivoLoteContabilidad.updateOne,
      m.consecutivoSaldoInicial.updateOne,
      m.consecutivoSaldoInicialAnticipo.updateOne,
      m.resoluciones.updateOne,
      m.storage.eliminarPrefijo,
      m.auditoria.registrar,
    ];

    it('rechaza con ConflictException y no borra nada si hay una consolidación en curso (progreso no nulo)', async () => {
      const modelos = makeModelos({
        loteConsolidando: { progreso: { actual: 3, total: 10 } },
      });
      const service = makeService(modelos);

      await expect(service.reiniciar(CUENTA)).rejects.toBeInstanceOf(
        ConflictException,
      );

      // Tenant-scoped, nunca findById, y pregunta por progreso no nulo.
      expect(modelos.lotes.findOne).toHaveBeenCalledWith({
        copropiedadId: COP,
        progreso: { $ne: null },
      });
      for (const escritura of todoLoQueEscribe(modelos)) {
        expect(escritura).not.toHaveBeenCalled();
      }
    });

    it('rechaza con ConflictException y no borra nada si hay un lote de recibos aplicándose en esta copropiedad', async () => {
      const modelos = makeModelos({
        trabajosAplicacion: [{ data: { copropiedadId: COP.toString() } }],
      });
      const service = makeService(modelos);

      await expect(service.reiniciar(CUENTA)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(modelos.colaAplicacionLoteRecibos.getJobs).toHaveBeenCalledWith(
        expect.arrayContaining(['active', 'waiting']),
      );
      for (const escritura of todoLoQueEscribe(modelos)) {
        expect(escritura).not.toHaveBeenCalled();
      }
    });

    it('un trabajo de aplicación de OTRA copropiedad no bloquea el reinicio', async () => {
      const modelos = makeModelos({
        trabajosAplicacion: [
          { data: { copropiedadId: new Types.ObjectId().toString() } },
        ],
      });
      const service = makeService(modelos);

      await expect(service.reiniciar(CUENTA)).resolves.toBeDefined();
    });

    it('el mensaje del rechazo está en español', async () => {
      const modelos = makeModelos({
        loteConsolidando: { progreso: { actual: 0, total: 0 } },
      });
      const service = makeService(modelos);

      await expect(service.reiniciar(CUENTA)).rejects.toThrow(/consolidación/);
    });

    it('falla cerrado: si la cola no responde, rechaza y no escribió nada', async () => {
      const modelos = makeModelos({ colaFalla: true });
      const service = makeService(modelos);

      await expect(service.reiniciar(CUENTA)).rejects.toThrow('redis caído');

      for (const escritura of todoLoQueEscribe(modelos)) {
        expect(escritura).not.toHaveBeenCalled();
      }
    });

    it.each(['saldos-iniciales', 'saldos-iniciales-anticipo'])(
      'una importación de %s en curso (progreso reciente) rechaza con ConflictException y no borra nada',
      async (tipo) => {
        const modelos = makeModelos({
          importacion: { tipo, updatedAt: new Date() },
        });
        const service = makeService(modelos);

        const intento = service.reiniciar(CUENTA);

        await expect(intento).rejects.toBeInstanceOf(ConflictException);
        await expect(intento).rejects.toThrow(
          /importación de Saldos Iniciales/,
        );
        for (const escritura of todoLoQueEscribe(modelos)) {
          expect(escritura).not.toHaveBeenCalled();
        }
      },
    );

    it('una fila de progreso VIEJA (importación caída) no bloquea y se borra como antes', async () => {
      const modelos = makeModelos({
        importacion: {
          tipo: 'saldos-iniciales',
          updatedAt: new Date(Date.now() - 16 * 60 * 1000),
        },
        deletedCounts: { progresosImportacion: 1 },
      });
      const service = makeService(modelos);

      const resultado = await service.reiniciar(CUENTA);

      expect(resultado.progresosImportacionEliminados).toBe(1);
      expect(modelos.progresosImportacion.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('el filtro de la guarda es por copropiedad, solo los dos tipos de saldos iniciales y una ventana de 15 minutos', async () => {
      const modelos = makeModelos({});
      const service = makeService(modelos);
      const antes = Date.now();

      await service.reiniciar(CUENTA);

      const [filtro] = modelos.progresosImportacion.findOne.mock
        .calls[0] as unknown as [
        {
          copropiedadId: Types.ObjectId;
          tipo: { $in: string[] };
          updatedAt: { $gte: Date };
        },
      ];
      expect(filtro.copropiedadId).toBe(COP);
      expect(filtro.tipo.$in).toEqual([
        'saldos-iniciales',
        'saldos-iniciales-anticipo',
      ]);
      const limite = filtro.updatedAt.$gte.getTime();
      expect(limite).toBeLessThanOrEqual(antes - 15 * 60 * 1000 + 1000);
      expect(limite).toBeGreaterThan(antes - 15 * 60 * 1000 - 5000);
    });
  });

  describe('fallo a mitad del borrado', () => {
    it('rechaza con el error ORIGINAL, no reinicia contadores ni toca el almacenamiento y registra UNA auditoría parcial', async () => {
      const modelos = makeModelos({ deletedCounts: { recibos: 3 } });
      // The second group of deletes fails: the first group (recibos, notas…)
      // is already gone by then.
      modelos.saldos.deleteMany.mockImplementation(() => ({
        exec: () => Promise.reject(new Error('mongo cayó')),
      }));
      const service = makeService(modelos);

      await expect(service.reiniciar(CUENTA)).rejects.toThrow('mongo cayó');

      expect(modelos.recibos.deleteMany).toHaveBeenCalled();
      expect(modelos.consecutivoLote.updateOne).not.toHaveBeenCalled();
      expect(modelos.consecutivoDocumento.updateMany).not.toHaveBeenCalled();
      expect(modelos.consecutivoLoteRecibos.updateOne).not.toHaveBeenCalled();
      expect(
        modelos.consecutivoLoteContabilidad.updateOne,
      ).not.toHaveBeenCalled();
      expect(modelos.consecutivoSaldoInicial.updateOne).not.toHaveBeenCalled();
      expect(
        modelos.consecutivoSaldoInicialAnticipo.updateOne,
      ).not.toHaveBeenCalled();
      expect(modelos.resoluciones.updateOne).not.toHaveBeenCalled();
      expect(modelos.storage.eliminarPrefijo).not.toHaveBeenCalled();

      expect(modelos.auditoria.registrar).toHaveBeenCalledTimes(1);
      const [entrada] = modelos.auditoria.registrar.mock
        .calls[0] as unknown as [Record<string, string>];
      expect(entrada).toMatchObject({
        actorAccountId: CUENTA,
        accion: 'reiniciar',
        entidadTipo: 'copropiedad',
        entidadId: COP.toString(),
      });
      expect(entrada.entidadEtiqueta).toContain('PARCIAL');
      expect(entrada.entidadEtiqueta).toContain('mongo cayó');
    });

    it('si además falla la auditoría parcial, igual se relanza el error original', async () => {
      const modelos = makeModelos({ auditoriaFalla: true });
      modelos.lotes.deleteMany.mockImplementation(() => ({
        exec: () => Promise.reject(new Error('mongo cayó')),
      }));
      const service = makeService(modelos);

      await expect(service.reiniciar(CUENTA)).rejects.toThrow('mongo cayó');
      expect(modelos.auditoria.registrar).toHaveBeenCalledTimes(1);
    });
  });

  describe('PresentacionDocumento', () => {
    it('se borra por prefijo anclado de objectPath y NO por copropiedadId (el esquema no lo tiene)', async () => {
      const modelos = makeModelos({ deletedCounts: { presentaciones: 4 } });
      const service = makeService(modelos);

      const resultado = await service.reiniciar(CUENTA);

      expect(modelos.presentaciones.deleteMany).toHaveBeenCalledTimes(1);
      const [filtro] = modelos.presentaciones.deleteMany.mock
        .calls[0] as unknown as [Record<string, unknown>];
      expect(filtro).not.toHaveProperty('copropiedadId');
      const { $regex } = filtro.objectPath as { $regex: string };
      expect($regex).toBe(`^${PREFIJO_PDFS.replace(/\./g, '\\.')}`);
      const regex = new RegExp($regex);
      expect(
        regex.test(`${PREFIJO_PDFS}FV/${new Types.ObjectId().toString()}.pdf`),
      ).toBe(true);
      // Anclado: ni otra copropiedad ni el mismo id como subcadena.
      expect(
        regex.test(
          `documentos-generados/${new Types.ObjectId().toString()}/FV/x.pdf`,
        ),
      ).toBe(false);
      expect(regex.test(`otro/${PREFIJO_PDFS}FV/x.pdf`)).toBe(false);
      expect(resultado.presentacionesEliminadas).toBe(4);
    });
  });

  describe('ProgresoImportacion', () => {
    it('borra solo los dos tipos de saldos iniciales de la copropiedad', async () => {
      const modelos = makeModelos({
        deletedCounts: { progresosImportacion: 2 },
      });
      const service = makeService(modelos);

      const resultado = await service.reiniciar(CUENTA);

      expect(modelos.progresosImportacion.deleteMany).toHaveBeenCalledWith({
        copropiedadId: COP,
        tipo: { $in: ['saldos-iniciales', 'saldos-iniciales-anticipo'] },
      });
      expect(resultado.progresosImportacionEliminados).toBe(2);
    });
  });

  describe('limpieza del almacenamiento', () => {
    it('borra el prefijo de la copropiedad DESPUÉS de todo el borrado en Mongo y devuelve cuántos archivos eliminó', async () => {
      const modelos = makeModelos({ archivosPdf: 7 });
      const service = makeService(modelos);

      const resultado = await service.reiniciar(CUENTA);

      expect(modelos.storage.eliminarPrefijo).toHaveBeenCalledWith(
        PREFIJO_PDFS,
      );
      const delStorage =
        modelos.storage.eliminarPrefijo.mock.invocationCallOrder[0];
      const ultimasEscrituras = [
        modelos.facturas.deleteMany,
        modelos.lotes.deleteMany,
        modelos.presentaciones.deleteMany,
        modelos.consecutivoSaldoInicialAnticipo.updateOne,
        modelos.resoluciones.findOne,
      ];
      for (const escritura of ultimasEscrituras) {
        expect(escritura.mock.invocationCallOrder[0]).toBeLessThan(delStorage);
      }
      expect(resultado.archivosPdfEliminados).toBe(7);
    });

    it('si algunos archivos no se pudieron borrar, informa los que sí y lo deja en la auditoría', async () => {
      const modelos = makeModelos({ archivosPdf: 8, archivosFallidos: 2 });
      const service = makeService(modelos);

      const resultado = await service.reiniciar(CUENTA);

      expect(resultado.archivosPdfEliminados).toBe(8);
      const [entrada] = modelos.auditoria.registrar.mock
        .calls[0] as unknown as [{ entidadEtiqueta: string }];
      expect(entrada.entidadEtiqueta).toContain('NO se pudieron borrar');
    });

    it('si el almacenamiento falla, el reinicio NO falla: devuelve archivosPdfEliminados 0 y lo deja en la auditoría', async () => {
      const modelos = makeModelos({
        storageFalla: true,
        deletedCounts: { facturas: 5 },
      });
      const service = makeService(modelos);

      const resultado = await service.reiniciar(CUENTA);

      expect(resultado.archivosPdfEliminados).toBe(0);
      expect(resultado.facturasEliminadas).toBe(5);
      const [entrada] = modelos.auditoria.registrar.mock
        .calls[0] as unknown as [{ entidadEtiqueta: string }];
      expect(entrada.entidadEtiqueta).toContain('NO se pudieron borrar');
    });
  });

  describe('auditoría', () => {
    it('registra UNA entrada accion "reiniciar" sobre la copropiedad, con el actor y los conteos', async () => {
      const modelos = makeModelos({
        deletedCounts: { facturas: 5, recibos: 3 },
        archivosPdf: 2,
      });
      const service = makeService(modelos);

      await service.reiniciar(CUENTA);

      expect(modelos.auditoria.registrar).toHaveBeenCalledTimes(1);
      const [entrada] = modelos.auditoria.registrar.mock
        .calls[0] as unknown as [Record<string, string>];
      expect(entrada).toMatchObject({
        actorAccountId: CUENTA,
        actorNombre: 'Admin Plataforma',
        accion: 'reiniciar',
        entidadTipo: 'copropiedad',
        entidadId: COP.toString(),
      });
      expect(entrada.entidadEtiqueta).toContain('facturasEliminadas: 5');
      expect(entrada.entidadEtiqueta).toContain('recibosEliminados: 3');
      expect(entrada.entidadEtiqueta).toContain('archivosPdfEliminados: 2');
      expect(entrada.entidadEtiqueta).toContain('0001 Edificio Sol');
    });

    it('si falla el registro de auditoría, el reinicio NO falla ni se deshace', async () => {
      const modelos = makeModelos({
        auditoriaFalla: true,
        deletedCounts: { facturas: 5 },
      });
      const service = makeService(modelos);

      const resultado = await service.reiniciar(CUENTA);

      expect(resultado.facturasEliminadas).toBe(5);
    });

    it('no registra auditoría si el reinicio fue rechazado por la guarda', async () => {
      const modelos = makeModelos({
        loteConsolidando: { progreso: { actual: 1, total: 2 } },
      });
      const service = makeService(modelos);

      await expect(service.reiniciar(CUENTA)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(modelos.auditoria.registrar).not.toHaveBeenCalled();
    });
  });
});

describe('Campos de contador que reiniciar() reescribe (regresión de renombrado)', () => {
  // Un `$set` sobre un campo que ya no existe en el esquema no falla: con
  // `strict` Mongoose lo descarta y el reinicio queda en un no-op silencioso.
  // Estos tests atan los nombres que usa el servicio a los esquemas reales.
  it.each([
    ['ConsecutivoLote', ConsecutivoLote],
    ['ConsecutivoLoteRecibos', ConsecutivoLoteRecibos],
    ['ConsecutivoSaldoInicial', ConsecutivoSaldoInicial],
    ['ConsecutivoSaldoInicialAnticipo', ConsecutivoSaldoInicialAnticipo],
    ['ConsecutivoDocumento', ConsecutivoDocumento],
  ])('%s tiene el campo siguienteNumero', (_nombre, clase) => {
    const schema = SchemaFactory.createForClass(clase);
    expect(schema.path('siguienteNumero')).toBeDefined();
  });

  it('ConsecutivoLoteContabilidad conserva legítimamente nextNumber', () => {
    const schema = SchemaFactory.createForClass(ConsecutivoLoteContabilidad);
    expect(schema.path('nextNumber')).toBeDefined();
  });

  it('ResolucionFacturacion tiene siguienteNumero y rangoDesde', () => {
    const schema = SchemaFactory.createForClass(ResolucionFacturacion);
    expect(schema.path('siguienteNumero')).toBeDefined();
    expect(schema.path('rangoDesde')).toBeDefined();
  });
});

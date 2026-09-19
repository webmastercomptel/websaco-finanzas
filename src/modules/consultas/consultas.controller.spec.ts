import { ConsultasController } from './consultas.controller';

const makeController = () => {
  const findAll = jest.fn();
  const findVencimientos = jest.fn();
  const findCarteraGeneral = jest.fn();
  const findCarteraPorInmueble = jest.fn();
  const findCarteraPorConceptos = jest.fn();
  const findPeriodosEstadoCuenta = jest.fn();
  const findAllEstadoCuenta = jest.fn();
  const generarPdfEstadoCuenta = jest.fn();
  const findAllMovimiento = jest.fn();
  const findPeriodosConciliacionCartera = jest.fn();
  const findAllConciliacionCartera = jest.fn();
  const findAllConsecutivos = jest.fn();
  const findResumenInicio = jest.fn();
  const findAllPistaAuditoria = jest.fn();
  const resolveCoPropertyId = jest.fn();
  const findByIdCopropiedad = jest.fn();

  const controller = new ConsultasController(
    { findAll } as never,
    { findVencimientos } as never,
    { findCarteraGeneral } as never,
    { findOne: findCarteraPorInmueble } as never,
    { findAll: findCarteraPorConceptos } as never,
    {
      findPeriodos: findPeriodosEstadoCuenta,
      findAll: findAllEstadoCuenta,
    } as never,
    { findAll: findAllMovimiento } as never,
    {
      findPeriodos: findPeriodosConciliacionCartera,
      findAll: findAllConciliacionCartera,
    } as never,
    { findAll: findAllConsecutivos } as never,
    { findResumen: findResumenInicio } as never,
    { findAll: findAllPistaAuditoria } as never,
    { resolveCoPropertyId } as never,
    {
      findById: () => ({ exec: findByIdCopropiedad }),
    } as never,
  );

  return {
    controller,
    findAll,
    findVencimientos,
    findCarteraGeneral,
    findCarteraPorInmueble,
    findCarteraPorConceptos,
    findPeriodosEstadoCuenta,
    findAllEstadoCuenta,
    generarPdfEstadoCuenta,
    findAllMovimiento,
    findPeriodosConciliacionCartera,
    findAllConciliacionCartera,
    findAllConsecutivos,
    findResumenInicio,
    findAllPistaAuditoria,
    resolveCoPropertyId,
    findByIdCopropiedad,
  };
};

describe('ConsultasController', () => {
  describe('cartera-por-inmueble', () => {
    it('delegates findOne to CarteraPorInmuebleService', async () => {
      const { controller, findCarteraPorInmueble } = makeController();
      const expected = { documentos: [], cargosPorConcepto: [] };
      findCarteraPorInmueble.mockResolvedValue(expected);

      const result = await controller.findCarteraPorInmueble({
        inmuebleId: '507f1f77bcf86cd799439011',
      });

      expect(result).toBe(expected);
      expect(findCarteraPorInmueble).toHaveBeenCalledWith({
        inmuebleId: '507f1f77bcf86cd799439011',
      });
    });
  });

  describe('cartera-por-conceptos', () => {
    it('delegates findAll to CarteraPorConceptosService', async () => {
      const { controller, findCarteraPorConceptos } = makeController();
      const expected = { conceptos: [], grupos: [] };
      findCarteraPorConceptos.mockResolvedValue(expected);

      const result = await controller.findCarteraPorConceptos({});

      expect(result).toBe(expected);
      expect(findCarteraPorConceptos).toHaveBeenCalledWith({});
    });
  });

  describe('movimiento-contable', () => {
    it('delegates findAll to MovimientoContableService', async () => {
      const { controller, findAllMovimiento } = makeController();
      const expected = { movimientos: [] };
      findAllMovimiento.mockResolvedValue(expected);

      const result = await controller.findMovimientoContable({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result).toBe(expected);
      expect(findAllMovimiento).toHaveBeenCalledWith({
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });
    });
  });

  describe('consecutivos', () => {
    it('delegates findAll to ConsecutivosService', async () => {
      const { controller, findAllConsecutivos } = makeController();
      const expected = { conceptos: [], filas: [] };
      findAllConsecutivos.mockResolvedValue(expected);

      const query = { codigo: 'RC', desde: '2026-01-01', hasta: '2026-01-31' };
      const result = await controller.findConsecutivos(query);

      expect(result).toBe(expected);
      expect(findAllConsecutivos).toHaveBeenCalledWith(query);
    });
  });

  describe('inicio-resumen', () => {
    it('delegates findResumen to InicioResumenService', async () => {
      const { controller, findResumenInicio } = makeController();
      const expected = {
        periodo: null,
        totalFacturado: 0,
        facturadoPorConcepto: [],
        totalIngresosRecibidos: 0,
        recibidoPorConcepto: [],
      };
      findResumenInicio.mockResolvedValue(expected);

      const result = await controller.findInicioResumen();

      expect(result).toBe(expected);
      expect(findResumenInicio).toHaveBeenCalledWith();
    });
  });

  describe('pista-auditoria', () => {
    it('delegates findAll to PistaAuditoriaService', async () => {
      const { controller, findAllPistaAuditoria } = makeController();
      const expected = {
        items: [],
        total: 0,
        pagina: 1,
        porPagina: 50,
        usuarios: [],
      };
      findAllPistaAuditoria.mockResolvedValue(expected);

      const query = { usuarioId: '507f1f77bcf86cd799439011' };
      const result = await controller.findPistaAuditoria(query);

      expect(result).toBe(expected);
      expect(findAllPistaAuditoria).toHaveBeenCalledWith(query);
    });
  });
});

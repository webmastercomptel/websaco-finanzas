import { ConsultasController } from './consultas.controller';

const makeController = () => {
  const findAll = jest.fn();
  const findVencimientos = jest.fn();
  const findCarteraGeneral = jest.fn();
  const findCarteraPorInmueble = jest.fn();
  const findPeriodosEstadoCuenta = jest.fn();
  const findAllEstadoCuenta = jest.fn();
  const generarPdfEstadoCuenta = jest.fn();
  const findAllMovimiento = jest.fn();
  const resolveCoPropertyId = jest.fn();
  const findByIdCopropiedad = jest.fn();

  const controller = new ConsultasController(
    { findAll } as never,
    { findVencimientos } as never,
    { findCarteraGeneral } as never,
    { findOne: findCarteraPorInmueble } as never,
    {
      findPeriodos: findPeriodosEstadoCuenta,
      findAll: findAllEstadoCuenta,
    } as never,
    { findAll: findAllMovimiento } as never,
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
    findPeriodosEstadoCuenta,
    findAllEstadoCuenta,
    generarPdfEstadoCuenta,
    findAllMovimiento,
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
});

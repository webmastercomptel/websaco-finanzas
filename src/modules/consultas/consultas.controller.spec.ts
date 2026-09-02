import { ConsultasController } from './consultas.controller';

const makeController = () => {
  const findAll = jest.fn();
  const findVencimientos = jest.fn();
  const findCarteraGeneral = jest.fn();
  const findPeriodosEstadoCuenta = jest.fn();
  const findAllEstadoCuenta = jest.fn();
  const generarPdfEstadoCuenta = jest.fn();
  const buscar = jest.fn();
  const findAllMovimiento = jest.fn();

  const controller = new ConsultasController(
    { findAll } as never,
    { findVencimientos } as never,
    { findCarteraGeneral } as never,
    {
      findPeriodos: findPeriodosEstadoCuenta,
      findAll: findAllEstadoCuenta,
    } as never,
    { buscar, findAll: findAllMovimiento } as never,
  );

  return {
    controller,
    findAll,
    findVencimientos,
    findCarteraGeneral,
    findPeriodosEstadoCuenta,
    findAllEstadoCuenta,
    generarPdfEstadoCuenta,
    buscar,
    findAllMovimiento,
  };
};

describe('ConsultasController', () => {
  describe('movimiento-contable/buscar', () => {
    it('delegates buscar to MovimientoContableService', async () => {
      const { controller, buscar } = makeController();
      const expected = { movimientos: [] };
      buscar.mockResolvedValue(expected);

      const result = await controller.buscarMovimientoContable({
        tipoDocumento: 'FC',
        numeroCompleto: 'FV-001',
      });

      expect(result).toBe(expected);
      expect(buscar).toHaveBeenCalledWith({
        tipoDocumento: 'FC',
        numeroCompleto: 'FV-001',
      });
    });
  });

  describe('movimiento-contable', () => {
    it('delegates findAll to MovimientoContableService', async () => {
      const { controller, findAllMovimiento } = makeController();
      const expected = { movimientos: [] };
      findAllMovimiento.mockResolvedValue(expected);

      const result = await controller.findMovimientoContable({
        inmuebleId: '507f1f77bcf86cd799439011',
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });

      expect(result).toBe(expected);
      expect(findAllMovimiento).toHaveBeenCalledWith({
        inmuebleId: '507f1f77bcf86cd799439011',
        desde: '2026-01-01',
        hasta: '2026-12-31',
      });
    });
  });
});

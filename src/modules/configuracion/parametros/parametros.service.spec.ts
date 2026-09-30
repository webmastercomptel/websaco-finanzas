import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ParametrosService } from './parametros.service';

const COP = new Types.ObjectId();
const tenant = () => ({ resolveCoPropertyId: () => COP }) as never;

const copropiedadDoc = (over: Record<string, unknown> = {}) => ({
  _id: COP,
  descuentoHabilitado: false,
  descuentoPorcentaje: 0,
  descuentoValorFijo: 0,
  descuentoDiasGracia: 0,
  descuentoAplicaConMora: false,
  moraHabilitada: false,
  moraTasaInteres: 0,
  moraValorLimite: null,
  cuentaBancariaDefecto: null,
  notasFacturacion: null,
  centroCostoDefecto: null,
  otrosIngresosCuentaDebito: null,
  otrosIngresosCuentaCredito: null,
  descuentosCuentaDebito: null,
  descuentosCuentaCredito: null,
  cuentaOrdenDebito: null,
  cuentaOrdenCredito: null,
  usaCuentasOrden: false,
  cuentaAnticipos: null,
  flujoCajaCodigo: null,
  ...over,
});

describe('ParametrosService.findOne', () => {
  it('mapea los 19 campos de la copropiedad activa', async () => {
    const copropiedades = {
      findById: jest.fn(() => ({
        exec: () =>
          Promise.resolve(
            copropiedadDoc({
              descuentoHabilitado: true,
              moraTasaInteres: 2.5,
              cuentaBancariaDefecto: '111005',
            }),
          ),
      })),
    };
    const service = new ParametrosService(copropiedades as never, tenant());

    const resultado = await service.findOne();

    expect(resultado).toEqual({
      descuentoHabilitado: true,
      porcentajeDescuento: 0,
      valorFijoDescuento: 0,
      diasGraciaDescuento: 0,
      descuentoAplicaConMora: false,
      moraHabilitada: false,
      tasaInteresMora: 2.5,
      topeValorMora: null,
      cuentaBancoPredeterminada: '111005',
      observacionesFacturacion: null,
      centroCostos: null,
      otrosIngresosDebito: null,
      otrosIngresosCredito: null,
      descuentosDebito: null,
      descuentosCredito: null,
      cuentasOrdenDebito: null,
      cuentasOrdenCredito: null,
      usaCuentasOrden: false,
      cuentaAnticipos: null,
      codigoFlujoCaja: null,
    });
  });

  it('responde "no existe" cuando la copropiedad no se encuentra', async () => {
    const copropiedades = {
      findById: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = new ParametrosService(copropiedades as never, tenant());

    await expect(service.findOne()).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ParametrosService.update', () => {
  it('solo escribe los campos enviados', async () => {
    const findByIdAndUpdate = jest.fn(
      (_id: unknown, _update: Record<string, unknown>) => ({
        exec: () => Promise.resolve(copropiedadDoc({ moraHabilitada: true })),
      }),
    );
    const copropiedades = { findByIdAndUpdate };
    const service = new ParametrosService(copropiedades as never, tenant());

    await service.update({ moraHabilitada: true });

    const [, update] = findByIdAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set).toEqual({ moraHabilitada: true });
  });

  it('responde "no existe" cuando la copropiedad no se encuentra', async () => {
    const copropiedades = {
      findByIdAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = new ParametrosService(copropiedades as never, tenant());

    await expect(
      service.update({ moraHabilitada: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

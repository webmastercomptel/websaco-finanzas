import 'reflect-metadata';
import { SaldosInicialesAnticipoController } from './saldos-iniciales-anticipo.controller';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
} from '../casl/check-ability.decorator';

/** Reads a route handler off the prototype without tripping unbound-method. */
const handlerDe = (proto: object, nombre: string): object =>
  Object.getOwnPropertyDescriptor(proto, nombre)?.value as object;

describe('SaldosInicialesAnticipoController.listarDisponibles', () => {
  it('delega al servicio con el filtro de inmueble', async () => {
    const servicio = {
      listarDisponibles: jest.fn(() => Promise.resolve([{ id: 'sia-1' }])),
    };
    const controller = new SaldosInicialesAnticipoController(servicio as never);

    const resultado = await controller.listarDisponibles({
      inmuebleId: '64b7f0c2a1b2c3d4e5f60718',
    });

    expect(servicio.listarDisponibles).toHaveBeenCalledWith({
      inmuebleId: '64b7f0c2a1b2c3d4e5f60718',
    });
    expect(resultado).toEqual([{ id: 'sia-1' }]);
  });

  it('exige alguna de: crear Nota Anticipo o leer SaldoInicialAnticipo', () => {
    const handler = handlerDe(
      SaldosInicialesAnticipoController.prototype,
      'listarDisponibles',
    );

    expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handler)).toEqual([
      { action: 'create', subject: 'NotaAnticipo' },
      { action: 'read', subject: 'SaldoInicialAnticipo' },
    ]);
    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handler)).toBeUndefined();
  });

  it('la ruta administrativa sigue exigiendo read SaldoInicialAnticipo', () => {
    const handler = handlerDe(
      SaldosInicialesAnticipoController.prototype,
      'listar',
    );

    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handler)).toEqual([
      { action: 'read', subject: 'SaldoInicialAnticipo' },
    ]);
    expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handler)).toBeUndefined();
  });
});

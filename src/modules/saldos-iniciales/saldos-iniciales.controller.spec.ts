import 'reflect-metadata';
import { SaldosInicialesController } from './saldos-iniciales.controller';
import {
  CHECK_ABILITY_KEY,
  CHECK_ANY_ABILITY_KEY,
} from '../casl/check-ability.decorator';

/** Reads a route handler off the prototype without tripping unbound-method. */
const handlerDe = (proto: object, nombre: string): object =>
  Object.getOwnPropertyDescriptor(proto, nombre)?.value as object;

const INMUEBLE_ID = '64b7f0c2a1b2c3d4e5f60718';

describe('SaldosInicialesController.listarAplicables', () => {
  it('delega al servicio con el inmueble y solo lo aplicable', async () => {
    const saldosIniciales = {
      listarAplicables: jest.fn(() => Promise.resolve([{ id: 'si-1' }])),
    };
    const controller = new SaldosInicialesController(saldosIniciales as never);

    const resultado = await controller.listarAplicables({
      inmuebleId: INMUEBLE_ID,
    });

    expect(saldosIniciales.listarAplicables).toHaveBeenCalledWith({
      inmuebleId: INMUEBLE_ID,
    });
    expect(resultado).toEqual([{ id: 'si-1' }]);
  });

  it('exige alguna de: crear Recibo, crear Nota Crédito, crear Nota Anticipo o leer SaldoInicial', () => {
    const handler = handlerDe(
      SaldosInicialesController.prototype,
      'listarAplicables',
    );

    expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handler)).toEqual([
      { action: 'create', subject: 'Recibo' },
      { action: 'create', subject: 'NotaCredito' },
      { action: 'create', subject: 'NotaAnticipo' },
      { action: 'read', subject: 'SaldoInicial' },
    ]);
    // Sin reglas AND: ninguna es obligatoria por sí sola.
    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handler)).toBeUndefined();
  });

  it('la ruta administrativa sigue exigiendo read SaldoInicial', () => {
    const handler = handlerDe(SaldosInicialesController.prototype, 'listar');

    expect(Reflect.getMetadata(CHECK_ABILITY_KEY, handler)).toEqual([
      { action: 'read', subject: 'SaldoInicial' },
    ]);
    expect(Reflect.getMetadata(CHECK_ANY_ABILITY_KEY, handler)).toBeUndefined();
  });
});

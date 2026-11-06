import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PortalController } from './portal.controller';

/** Every `path` declared by a handler of the controller. */
const rutas = (): string[] =>
  Object.getOwnPropertyNames(PortalController.prototype)
    .filter((n) => n !== 'constructor')
    .map(
      (n) =>
        (PortalController.prototype as unknown as Record<string, object>)[n],
    )
    .filter((fn) => Reflect.getMetadata(METHOD_METADATA, fn) !== undefined)
    .map((fn) => String(Reflect.getMetadata(PATH_METADATA, fn)));

describe('PortalController — superficie expuesta', () => {
  it('expone exactamente estas cuatro rutas de lectura', () => {
    expect(rutas().sort()).toEqual([
      'estado-cuenta',
      'facturas',
      'facturas/:id/documento-pdf',
      'unidades',
    ]);
  });

  it('ninguna ruta del portal toca recibos: son internos', () => {
    expect(rutas().filter((r) => /recibo/i.test(r))).toEqual([]);
  });
});

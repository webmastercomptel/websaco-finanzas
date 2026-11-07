import {
  esTipoEnviable,
  puedeVerTipo,
  TIPOS_DE_RESIDENTE,
} from './facturacion-bloque-acceso';

describe('puedeVerTipo — quién ve qué', () => {
  it.each([
    ['propietario', 'factura', true],
    ['propietario', 'estado_cuenta', true],
    ['propietario', 'recibo', false],
    ['arrendatario', 'factura', true],
    ['arrendatario', 'estado_cuenta', false],
    ['arrendatario', 'recibo', false],
  ] as const)('%s + %s => %s', (rol, tipo, esperado) => {
    expect(puedeVerTipo(rol, tipo)).toBe(esperado);
  });

  it('el recibo no figura entre lo que un residente puede pedir', () => {
    expect([...TIPOS_DE_RESIDENTE]).toEqual(['factura', 'estado_cuenta']);
  });
});

describe('esTipoEnviable', () => {
  it('factura y estado de cuenta se envían; el recibo no', () => {
    expect(esTipoEnviable('factura')).toBe(true);
    expect(esTipoEnviable('estado_cuenta')).toBe(true);
    expect(esTipoEnviable('recibo')).toBe(false);
  });
});

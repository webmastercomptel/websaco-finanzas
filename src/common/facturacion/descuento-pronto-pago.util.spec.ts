import {
  calcularDescuentoProntoPago,
  type LineaParaDescuento,
} from './descuento-pronto-pago.util';

describe('calcularDescuentoProntoPago', () => {
  const lineaAdministracion: LineaParaDescuento = {
    conceptKind: 'administracion',
    baseAmount: 200000,
    totalAmount: 200000,
  };
  const deadline = new Date('2026-08-10');

  it('no ofrece descuento cuando ni el % ni el valor fijo están configurados', () => {
    expect(
      calcularDescuentoProntoPago([lineaAdministracion], 0, 0, deadline, false),
    ).toEqual({ discountAmount: 0, discountDeadline: null });
  });

  it('no ofrece descuento cuando el ciclo tiene mora y descuentoAplicaConMora es false', () => {
    const lineaMora: LineaParaDescuento = {
      conceptKind: 'intereses',
      baseAmount: 5000,
      totalAmount: 5000,
    };
    expect(
      calcularDescuentoProntoPago(
        [lineaAdministracion, lineaMora],
        5,
        0,
        deadline,
        false,
      ),
    ).toEqual({ discountAmount: 0, discountDeadline: null });
  });

  it('SÍ ofrece descuento con mora cuando descuentoAplicaConMora es true', () => {
    const lineaMora: LineaParaDescuento = {
      conceptKind: 'intereses',
      baseAmount: 5000,
      totalAmount: 5000,
    };
    expect(
      calcularDescuentoProntoPago(
        [lineaAdministracion, lineaMora],
        5,
        0,
        deadline,
        true,
      ),
    ).toEqual({ discountAmount: 10000, discountDeadline: deadline });
  });

  it('no ofrece descuento cuando no hay línea de Administración', () => {
    const lineaOtro: LineaParaDescuento = {
      conceptKind: 'otro',
      baseAmount: 200000,
      totalAmount: 200000,
    };
    expect(
      calcularDescuentoProntoPago([lineaOtro], 5, 0, deadline, false),
    ).toEqual({ discountAmount: 0, discountDeadline: null });
  });

  it('calcula el descuento sobre la base de Administración cuando hay %', () => {
    const resultado = calcularDescuentoProntoPago(
      [lineaAdministracion],
      5,
      0,
      deadline,
      false,
    );
    expect(resultado).toEqual({
      discountAmount: 10000,
      discountDeadline: deadline,
    });
  });

  it('usa el valor fijo directo, sin calcular, cuando no hay %', () => {
    const resultado = calcularDescuentoProntoPago(
      [lineaAdministracion],
      0,
      15000,
      deadline,
      false,
    );
    expect(resultado).toEqual({
      discountAmount: 15000,
      discountDeadline: deadline,
    });
  });

  it('el % gana sobre el valor fijo cuando ambos están configurados', () => {
    const resultado = calcularDescuentoProntoPago(
      [lineaAdministracion],
      5,
      99999,
      deadline,
      false,
    );
    expect(resultado).toEqual({
      discountAmount: 10000,
      discountDeadline: deadline,
    });
  });
});

import {
  formatoPeso,
  formatoPesoSinSimbolo,
  formatoSaldoConFavor,
} from './pdf-helpers';

describe('formatoPesoSinSimbolo', () => {
  it('formatea con separador de miles y sin el signo $', () => {
    expect(formatoPesoSinSimbolo(1234567)).toBe('1.234.567');
    expect(formatoPesoSinSimbolo(1234567.8)).toBe('1.234.568');
  });
});

describe('formatoSaldoConFavor', () => {
  it('agrega el sufijo "(A Favor)" cuando el valor es negativo — saldo a favor del propietario', () => {
    expect(formatoSaldoConFavor(-90200)).toBe('$ -90.200 (A Favor)');
  });

  it('nunca invierte el signo — el número negativo crudo queda intacto, no se convierte a positivo', () => {
    expect(formatoSaldoConFavor(-90200)).toBe(
      `${formatoPeso(-90200)} (A Favor)`,
    );
  });

  it('NO agrega el sufijo cuando el valor es positivo', () => {
    expect(formatoSaldoConFavor(90200)).toBe(formatoPeso(90200));
  });

  it('NO agrega el sufijo cuando el valor es exactamente cero', () => {
    expect(formatoSaldoConFavor(0)).toBe(formatoPeso(0));
  });
});

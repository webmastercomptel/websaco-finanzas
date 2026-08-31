import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { validarDistribucionNotaCredito } from './distribucion.util';

const CONCEPTO_A = new Types.ObjectId().toString();
const CONCEPTO_B = new Types.ObjectId().toString();

const lineasFactura = [
  { conceptoId: new Types.ObjectId(CONCEPTO_A), totalAmount: 300000 },
  { conceptoId: new Types.ObjectId(CONCEPTO_B), totalAmount: 200000 },
];

describe('validarDistribucionNotaCredito', () => {
  it('acepta una distribución que suma exacto al monto total y respeta los topes por concepto', () => {
    expect(() =>
      validarDistribucionNotaCredito(
        [
          { conceptoId: CONCEPTO_A, monto: 150000 },
          { conceptoId: CONCEPTO_B, monto: 50000 },
        ],
        200000,
        lineasFactura,
      ),
    ).not.toThrow();
  });

  it('rechaza cuando la distribución no suma exacto al monto total', () => {
    expect(() =>
      validarDistribucionNotaCredito(
        [{ conceptoId: CONCEPTO_A, monto: 150000 }],
        200000,
        lineasFactura,
      ),
    ).toThrow(BadRequestException);
  });

  it('rechaza cuando una línea supera el tope de su concepto en la factura ancla', () => {
    expect(() =>
      validarDistribucionNotaCredito(
        [{ conceptoId: CONCEPTO_A, monto: 350000 }],
        350000,
        lineasFactura,
      ),
    ).toThrow(BadRequestException);
  });

  it('rechaza un concepto que no existe en la factura ancla — tope implícito de cero', () => {
    const conceptoAjeno = new Types.ObjectId().toString();
    expect(() =>
      validarDistribucionNotaCredito(
        [{ conceptoId: conceptoAjeno, monto: 1 }],
        1,
        lineasFactura,
      ),
    ).toThrow(BadRequestException);
  });

  it('suma varias líneas del mismo concepto contra su tope combinado', () => {
    // La factura ancla puede tener más de una línea para el mismo concepto
    // (p. ej. una novedad y su recurrente) — el tope es la suma, no cada
    // línea por separado.
    const lineasConDosDelMismoConcepto = [
      { conceptoId: new Types.ObjectId(CONCEPTO_A), totalAmount: 100000 },
      { conceptoId: new Types.ObjectId(CONCEPTO_A), totalAmount: 100000 },
    ];

    expect(() =>
      validarDistribucionNotaCredito(
        [{ conceptoId: CONCEPTO_A, monto: 180000 }],
        180000,
        lineasConDosDelMismoConcepto,
      ),
    ).not.toThrow();
  });
});

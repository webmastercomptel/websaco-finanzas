import { construirMovimientos } from './asiento.builder';

describe('construirMovimientos', () => {
  it('colapsa a un débito y un crédito para el caso común: una sola cuenta de ingreso', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lines: [{ accountingIncomeAccount: '413501', totalAmount: 520000 }],
      },
      '130501',
    );

    expect(movimientos).toEqual([
      {
        account: '130501',
        type: 'debito',
        amount: 520000,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        description: expect.any(String),
      },
      {
        account: '413501',
        type: 'credito',
        amount: 520000,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        description: expect.any(String),
      },
    ]);
  });

  it('genera un crédito por cada cuenta de ingreso distinta', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lines: [
          { accountingIncomeAccount: '413501', totalAmount: 520000 },
          { accountingIncomeAccount: '413502', totalAmount: 200000 },
        ],
      },
      '130501',
    );

    const creditos = movimientos.filter((m) => m.type === 'credito');
    expect(creditos).toHaveLength(2);
    expect(creditos.find((c) => c.account === '413501')?.amount).toBe(520000);
    expect(creditos.find((c) => c.account === '413502')?.amount).toBe(200000);
  });

  it('agrupa líneas que comparten la misma cuenta de ingreso en un solo crédito', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lines: [
          { accountingIncomeAccount: '413501', totalAmount: 520000 },
          { accountingIncomeAccount: '413501', totalAmount: 200000 },
        ],
      },
      '130501',
    );

    const creditos = movimientos.filter((m) => m.type === 'credito');
    expect(creditos).toHaveLength(1);
    expect(creditos[0].amount).toBe(720000);
  });

  it('respeta el invariante de partida doble: los débitos suman lo mismo que los créditos', () => {
    const movimientos = construirMovimientos(
      {
        total: 1013600,
        lines: [
          { accountingIncomeAccount: '413501', totalAmount: 520000 },
          { accountingIncomeAccount: null, totalAmount: 493600 },
        ],
      },
      '130501',
    );

    const suma = (type: 'debito' | 'credito') =>
      movimientos
        .filter((m) => m.type === type)
        .reduce((acc, m) => acc + m.amount, 0);

    expect(suma('debito')).toBe(suma('credito'));
    expect(suma('debito')).toBe(1013600);
  });

  it('usa una cuenta de reserva cuando una línea no tiene cuenta contable asignada', () => {
    const movimientos = construirMovimientos(
      {
        total: 100000,
        lines: [{ accountingIncomeAccount: null, totalAmount: 100000 }],
      },
      '130501',
    );

    const credito = movimientos.find((m) => m.type === 'credito');
    expect(credito?.account).toBe('SIN-CUENTA-ASIGNADA');
  });
});

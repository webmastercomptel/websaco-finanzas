import {
  construirMovimientos,
  construirAsientoRecibo,
  construirMovimientosAplicacionAnticipo,
  construirContraAsientoRecibo,
} from './asiento.builder';

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

describe('construirAsientoRecibo', () => {
  it('debita SIEMPRE la cuenta destino por el monto recibido completo, aplicado o no', () => {
    const movimientos = construirAsientoRecibo(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
    );

    const debito = movimientos.find((m) => m.account === '111005');
    expect(debito).toMatchObject({ type: 'debito', amount: 300000 });
  });

  it('acredita cartera por lo aplicado y anticipos por lo que queda sin aplicar', () => {
    const movimientos = construirAsientoRecibo(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
    );

    expect(movimientos).toEqual([
      { account: '111005', type: 'debito', amount: 300000, description: expect.any(String) },
      { account: '130501', type: 'credito', amount: 200000, description: expect.any(String) },
      { account: '210505', type: 'credito', amount: 100000, description: expect.any(String) },
    ]);
  });

  it('un anticipo puro (nada aplicado) no acredita cartera, solo anticipos', () => {
    const movimientos = construirAsientoRecibo('111005', '130501', '210505', 0, 500000);

    expect(movimientos).toEqual([
      { account: '111005', type: 'debito', amount: 500000, description: expect.any(String) },
      { account: '210505', type: 'credito', amount: 500000, description: expect.any(String) },
    ]);
  });

  it('una aplicación total (nada de anticipo) no acredita anticipos, solo cartera', () => {
    const movimientos = construirAsientoRecibo('111005', '130501', '210505', 500000, 0);

    expect(movimientos).toEqual([
      { account: '111005', type: 'debito', amount: 500000, description: expect.any(String) },
      { account: '130501', type: 'credito', amount: 500000, description: expect.any(String) },
    ]);
  });

  it('siempre balanceado: el débito iguala la suma de los créditos', () => {
    const movimientos = construirAsientoRecibo('111005', '130501', '210505', 120000, 380000);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.type === t).reduce((a, m) => a + m.amount, 0);

    expect(suma('debito')).toBe(suma('credito'));
    expect(suma('debito')).toBe(500000);
  });
});

describe('construirMovimientosAplicacionAnticipo', () => {
  it('debita anticipos y acredita cartera por lo aplicado en esta llamada — nunca mueve la cuenta destino', () => {
    const movimientos = construirMovimientosAplicacionAnticipo('210505', '130501', 150000);

    expect(movimientos).toEqual([
      { account: '210505', type: 'debito', amount: 150000, description: expect.any(String) },
      { account: '130501', type: 'credito', amount: 150000, description: expect.any(String) },
    ]);
  });
});

describe('construirContraAsientoRecibo', () => {
  it('con aplicado y anticipo remanente, revierte ambas patas y devuelve el recaudo completo', () => {
    const movimientos = construirContraAsientoRecibo(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      300000,
    );

    expect(movimientos).toEqual([
      { account: '130501', type: 'debito', amount: 200000, description: expect.any(String) },
      { account: '210505', type: 'debito', amount: 100000, description: expect.any(String) },
      { account: '111005', type: 'credito', amount: 300000, description: expect.any(String) },
    ]);
  });

  it('un recibo que era 100% anticipo revierte solo la pata de anticipos', () => {
    const movimientos = construirContraAsientoRecibo(
      '111005',
      '130501',
      '210505',
      0,
      500000,
      500000,
    );

    expect(movimientos).toEqual([
      { account: '210505', type: 'debito', amount: 500000, description: expect.any(String) },
      { account: '111005', type: 'credito', amount: 500000, description: expect.any(String) },
    ]);
  });

  it('un recibo totalmente aplicado revierte solo la pata de cartera', () => {
    const movimientos = construirContraAsientoRecibo(
      '111005',
      '130501',
      '210505',
      500000,
      0,
      500000,
    );

    expect(movimientos).toEqual([
      { account: '130501', type: 'debito', amount: 500000, description: expect.any(String) },
      { account: '111005', type: 'credito', amount: 500000, description: expect.any(String) },
    ]);
  });

  it('siempre balanceado: los débitos igualan el crédito, porque montoAplicado + montoSinAplicar === montoRecibido', () => {
    const movimientos = construirContraAsientoRecibo(
      '111005', '130501', '210505', 120000, 380000, 500000,
    );
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.type === t).reduce((a, m) => a + m.amount, 0);

    expect(suma('debito')).toBe(suma('credito'));
  });
});

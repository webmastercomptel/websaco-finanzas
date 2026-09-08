import {
  construirMovimientos,
  enriquecerMovimientosConAuxiliares,
  construirAsientoCruce,
  construirMovimientosAplicacionAnticipo,
  construirContraAsientoCruce,
  construirMovimientosReclasificacion,
  construirContraAsientoNotaDebito,
  cuentasOrdenDe,
  invertirCuentasOrden,
} from './asiento.builder';

describe('construirMovimientos', () => {
  it('produce un débito y un crédito para una factura de una sola línea', () => {
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

  it('NUNCA fusiona líneas que comparten cuenta: cada cargo genera su propio movimiento', () => {
    // Corrige un comportamiento anterior (confirmado erróneo con producto):
    // Pintura y Televisión, aunque configuradas con la MISMA cuenta débito y
    // crédito, deben verse como dos movimientos separados en el asiento —
    // nunca colapsados en uno solo con el monto combinado. Un cargo que no
    // genera su propia línea es, para quien concilia, un cargo sin codificar.
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lines: [
          {
            conceptName: 'Pintura',
            accountingReceivableAccount: '130501',
            accountingIncomeAccount: '413501',
            totalAmount: 520000,
          },
          {
            conceptName: 'Televisión por Cable',
            accountingReceivableAccount: '130501',
            accountingIncomeAccount: '413501',
            totalAmount: 200000,
          },
        ],
      },
      '130501',
    );

    const debitos = movimientos.filter((m) => m.type === 'debito');
    const creditos = movimientos.filter((m) => m.type === 'credito');

    expect(debitos).toHaveLength(2);
    expect(debitos.map((d) => d.amount).sort()).toEqual([200000, 520000]);
    expect(creditos).toHaveLength(2);
    expect(creditos.map((c) => c.amount).sort()).toEqual([200000, 520000]);

    // Aunque comparten cuenta, la descripción sigue distinguiendo cada
    // cargo — eso es lo que hace visible que son dos movimientos, no uno.
    expect(debitos.find((d) => d.amount === 520000)?.description).toBe(
      'Pintura',
    );
    expect(debitos.find((d) => d.amount === 200000)?.description).toBe(
      'Televisión por Cable',
    );
    expect(creditos.find((c) => c.amount === 520000)?.description).toBe(
      'Pintura',
    );
    expect(creditos.find((c) => c.amount === 200000)?.description).toBe(
      'Televisión por Cable',
    );
  });

  it('usa el nombre del cargo (pestaña Cargos) como descripción cuando la línea lo trae', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lines: [
          {
            conceptName: 'Administración',
            accountingIncomeAccount: '413501',
            totalAmount: 520000,
          },
        ],
      },
      '130501',
    );

    expect(movimientos.every((m) => m.description === 'Administración')).toBe(
      true,
    );
  });

  it('cae a la descripción genérica cuando la línea no trae nombre de cargo (p. ej. Nota Débito)', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lines: [{ accountingIncomeAccount: '413501', totalAmount: 520000 }],
      },
      '130501',
    );

    const debito = movimientos.find((m) => m.type === 'debito');
    const credito = movimientos.find((m) => m.type === 'credito');
    expect(debito?.description).toBe('Cartera por cobrar — factura de venta');
    expect(credito?.description).toBe('Ingreso por factura de venta');
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

  it('codifica cada cargo con su propia cuenta aunque haya cuentasOrden, excepto el cargo de intereses', () => {
    // Corrige una lectura anterior (confirmada errónea con producto):
    // cuentasOrden NO reemplaza la codificación de toda la factura, solo la
    // de la línea de intereses por mora ("Cargo 2").
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lines: [
          {
            conceptKind: 'administracion',
            accountingIncomeAccount: '413501',
            accountingReceivableAccount: '130501',
            totalAmount: 520000,
          },
          {
            conceptKind: 'intereses',
            accountingIncomeAccount: '413599',
            accountingReceivableAccount: '130599',
            totalAmount: 200000,
          },
        ],
      },
      '130501',
      { debito: '831505', credito: '831510' },
    );

    const debitos = movimientos.filter((m) => m.type === 'debito');
    const creditos = movimientos.filter((m) => m.type === 'credito');

    expect(debitos.find((d) => d.account === '130501')?.amount).toBe(520000);
    expect(debitos.find((d) => d.account === '831505')?.amount).toBe(200000);
    expect(debitos.find((d) => d.account === '130599')).toBeUndefined();

    expect(creditos.find((c) => c.account === '413501')?.amount).toBe(520000);
    expect(creditos.find((c) => c.account === '831510')?.amount).toBe(200000);
    expect(creditos.find((c) => c.account === '413599')).toBeUndefined();

    const suma = (type: 'debito' | 'credito') =>
      movimientos
        .filter((m) => m.type === type)
        .reduce((acc, m) => acc + m.amount, 0);
    expect(suma('debito')).toBe(suma('credito'));
    expect(suma('debito')).toBe(720000);
  });

  it('el nombre del cargo gana sobre el texto genérico de cuentas de orden', () => {
    const movimientos = construirMovimientos(
      {
        total: 200000,
        lines: [
          {
            conceptKind: 'intereses',
            conceptName: 'Intereses por Mora',
            accountingIncomeAccount: '413599',
            accountingReceivableAccount: '130599',
            totalAmount: 200000,
          },
        ],
      },
      '130501',
      { debito: '831505', credito: '831510' },
    );

    expect(
      movimientos.every((m) => m.description === 'Intereses por Mora'),
    ).toBe(true);
  });

  it('codifica el cargo de intereses con su propia cuenta cuando no hay cuentasOrden', () => {
    const movimientos = construirMovimientos(
      {
        total: 200000,
        lines: [
          {
            conceptKind: 'intereses',
            accountingIncomeAccount: '413599',
            accountingReceivableAccount: '130599',
            totalAmount: 200000,
          },
        ],
      },
      '130501',
      null,
    );

    expect(movimientos).toEqual([
      {
        account: '130599',
        type: 'debito',
        amount: 200000,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        description: expect.any(String),
      },
      {
        account: '413599',
        type: 'credito',
        amount: 200000,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        description: expect.any(String),
      },
    ]);
  });

  it('omite las cuentas de orden cuando no se proveen', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lines: [{ accountingIncomeAccount: '413501', totalAmount: 520000 }],
      },
      '130501',
      null,
    );

    expect(movimientos).toHaveLength(2);
  });

  it('debita la cuenta propia de cada concepto cuando la línea trae accountingReceivableAccount', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lines: [
          {
            accountingIncomeAccount: '413501',
            accountingReceivableAccount: '130501',
            totalAmount: 520000,
          },
          {
            accountingIncomeAccount: '413502',
            accountingReceivableAccount: '130502',
            totalAmount: 200000,
          },
        ],
      },
      '130501',
    );

    const debitos = movimientos.filter((m) => m.type === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.find((d) => d.account === '130501')?.amount).toBe(520000);
    expect(debitos.find((d) => d.account === '130502')?.amount).toBe(200000);

    const suma = (type: 'debito' | 'credito') =>
      movimientos
        .filter((m) => m.type === type)
        .reduce((acc, m) => acc + m.amount, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });

  it('cae a cuentaCartera cuando una línea no trae accountingReceivableAccount propio', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lines: [
          {
            accountingIncomeAccount: '413501',
            accountingReceivableAccount: '130502',
            totalAmount: 520000,
          },
          { accountingIncomeAccount: '413502', totalAmount: 200000 },
        ],
      },
      '130501',
    );

    const debitos = movimientos.filter((m) => m.type === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.find((d) => d.account === '130502')?.amount).toBe(520000);
    expect(debitos.find((d) => d.account === '130501')?.amount).toBe(200000);
  });

  it('NO fusiona dos líneas que comparten la misma cuenta de débito: un movimiento por línea', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lines: [
          {
            accountingIncomeAccount: '413501',
            accountingReceivableAccount: '130502',
            totalAmount: 520000,
          },
          {
            accountingIncomeAccount: '413502',
            accountingReceivableAccount: '130502',
            totalAmount: 200000,
          },
        ],
      },
      '130501',
    );

    const debitos = movimientos.filter((m) => m.type === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.every((d) => d.account === '130502')).toBe(true);
    expect(debitos.map((d) => d.amount).sort()).toEqual([200000, 520000]);
  });

  it('con taxAmount > 0, separa el crédito en base (ingreso) e impuesto (cuenta propia), sin tocar el débito', () => {
    const movimientos = construirMovimientos(
      {
        total: 119000,
        lines: [
          {
            accountingIncomeAccount: '413501',
            accountingReceivableAccount: '130501',
            accountingTaxAccount: '240815',
            totalAmount: 119000,
            taxAmount: 19000,
          },
        ],
      },
      '130501',
    );

    expect(movimientos).toHaveLength(3);
    const debito = movimientos.find((m) => m.type === 'debito');
    expect(debito).toMatchObject({ account: '130501', amount: 119000 });

    const creditoIngreso = movimientos.find(
      (m) => m.type === 'credito' && m.account === '413501',
    );
    expect(creditoIngreso).toMatchObject({ amount: 100000 });

    const creditoImpuesto = movimientos.find(
      (m) => m.type === 'credito' && m.account === '240815',
    );
    expect(creditoImpuesto).toMatchObject({
      amount: 19000,
      baseGravable: 100000,
    });
  });

  it('sin cuentaImpuestoId configurada, el crédito del impuesto cae en CUENTA_SIN_ASIGNAR', () => {
    const movimientos = construirMovimientos(
      {
        total: 119000,
        lines: [
          {
            accountingIncomeAccount: '413501',
            totalAmount: 119000,
            taxAmount: 19000,
            accountingTaxAccount: null,
          },
        ],
      },
      '130501',
    );

    const creditoImpuesto = movimientos.find(
      (m) => m.type === 'credito' && m.amount === 19000,
    );
    expect(creditoImpuesto?.account).toBe('SIN-CUENTA-ASIGNADA');
  });

  it('con taxAmount 0 (u omitido), mantiene el comportamiento actual: un solo crédito por el total', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lines: [{ accountingIncomeAccount: '413501', totalAmount: 520000 }],
      },
      '130501',
    );

    const creditos = movimientos.filter((m) => m.type === 'credito');
    expect(creditos).toEqual([
      expect.objectContaining({ account: '413501', amount: 520000 }),
    ]);
  });
});

describe('enriquecerMovimientosConAuxiliares', () => {
  const movimientoBase = (
    over: Partial<ReturnType<typeof construirMovimientos>[number]> = {},
  ) => ({
    account: '130501',
    type: 'debito' as const,
    amount: 100000,
    description: 'algo',
    ...over,
  });

  it('agrega tercero solo a las líneas cuya cuenta lo requiere', () => {
    const movimientos = [
      movimientoBase({ account: '130501' }),
      movimientoBase({ account: '413501' }),
    ];
    const cuentasPorCodigo = new Map([
      [
        '130501',
        {
          requiereTercero: true,
          centroUtilidad: false,
          centroDestino: false,
          flujoCaja: false,
        },
      ],
      [
        '413501',
        {
          requiereTercero: false,
          centroUtilidad: false,
          centroDestino: false,
          flujoCaja: false,
        },
      ],
    ]);

    const resultado = enriquecerMovimientosConAuxiliares(
      movimientos,
      cuentasPorCodigo,
      {
        terceroCode: '1304',
        centroCosto: null,
        flujoCajaCodigo: null,
      },
    );

    expect(resultado[0].tercero).toBe('1304');
    expect(resultado[1].tercero).toBeNull();
  });

  it('agrega centroCosto cuando la cuenta tiene centroUtilidad O centroDestino', () => {
    const movimientos = [movimientoBase()];
    const cuentasPorCodigo = new Map([
      [
        '130501',
        {
          requiereTercero: false,
          centroUtilidad: false,
          centroDestino: true,
          flujoCaja: false,
        },
      ],
    ]);

    const [resultado] = enriquecerMovimientosConAuxiliares(
      movimientos,
      cuentasPorCodigo,
      {
        terceroCode: null,
        centroCosto: 'CC-01',
        flujoCajaCodigo: null,
      },
    );

    expect(resultado.centroCosto).toBe('CC-01');
  });

  it('agrega flujoCaja cuando la cuenta lo tiene marcado', () => {
    const movimientos = [movimientoBase()];
    const cuentasPorCodigo = new Map([
      [
        '130501',
        {
          requiereTercero: false,
          centroUtilidad: false,
          centroDestino: false,
          flujoCaja: true,
        },
      ],
    ]);

    const [resultado] = enriquecerMovimientosConAuxiliares(
      movimientos,
      cuentasPorCodigo,
      {
        terceroCode: null,
        centroCosto: null,
        flujoCajaCodigo: 'FC-OPER',
      },
    );

    expect(resultado.flujoCaja).toBe('FC-OPER');
  });

  it('una cuenta ausente del mapa (no configurada) no agrega nada', () => {
    const movimientos = [movimientoBase({ account: 'SIN-CUENTA-ASIGNADA' })];

    const [resultado] = enriquecerMovimientosConAuxiliares(
      movimientos,
      new Map(),
      { terceroCode: '1304', centroCosto: 'CC-01', flujoCajaCodigo: 'FC-OPER' },
    );

    expect(resultado.tercero ?? null).toBeNull();
    expect(resultado.centroCosto ?? null).toBeNull();
    expect(resultado.flujoCaja ?? null).toBeNull();
  });
});

describe('construirAsientoCruce', () => {
  it('debita SIEMPRE la cuenta de origen por el monto recibido completo, aplicado o no', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
    );

    const debito = movimientos.find((m) => m.account === '111005');
    expect(debito).toMatchObject({ type: 'debito', amount: 300000 });
  });

  it('acredita cartera por lo aplicado y anticipos por lo que queda sin aplicar', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
    );

    expect(movimientos).toEqual([
      {
        account: '111005',
        type: 'debito',
        amount: 300000,
        description: expect.any(String),
      },
      {
        account: '130501',
        type: 'credito',
        amount: 200000,
        description: expect.any(String),
      },
      {
        account: '210505',
        type: 'credito',
        amount: 100000,
        description: expect.any(String),
      },
    ]);
  });

  it('un anticipo puro (nada aplicado) no acredita cartera, solo anticipos', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      0,
      500000,
      'RC',
    );

    expect(movimientos).toEqual([
      {
        account: '111005',
        type: 'debito',
        amount: 500000,
        description: expect.any(String),
      },
      {
        account: '210505',
        type: 'credito',
        amount: 500000,
        description: expect.any(String),
      },
    ]);
  });

  it('una aplicación total (nada de anticipo) no acredita anticipos, solo cartera', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      500000,
      0,
      'RC',
    );

    expect(movimientos).toEqual([
      {
        account: '111005',
        type: 'debito',
        amount: 500000,
        description: expect.any(String),
      },
      {
        account: '130501',
        type: 'credito',
        amount: 500000,
        description: expect.any(String),
      },
    ]);
  });

  it('con desgloseCartera, acredita cada cuenta propia en vez de la cuenta plana de cartera', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      500000,
      0,
      'RC',
      null,
      [
        { account: '130510', monto: 300000 },
        { account: '130520', monto: 200000 },
      ],
    );

    const creditos = movimientos.filter((m) => m.type === 'credito');
    expect(creditos).toHaveLength(2);
    expect(creditos.find((c) => c.account === '130510')?.amount).toBe(300000);
    expect(creditos.find((c) => c.account === '130520')?.amount).toBe(200000);
    expect(creditos.some((c) => c.account === '130501')).toBe(false);
  });

  it('desgloseCartera agrupa entradas repetidas de la misma cuenta', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      500000,
      0,
      'RC',
      null,
      [
        { account: '130510', monto: 300000 },
        { account: '130510', monto: 200000 },
      ],
    );

    const creditos = movimientos.filter((m) => m.type === 'credito');
    expect(creditos).toHaveLength(1);
    expect(creditos[0]).toMatchObject({ account: '130510', amount: 500000 });
  });

  it('un desgloseCartera vacío cae a la cuenta plana de cartera', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      500000,
      0,
      'RC',
      null,
      [],
    );

    const creditos = movimientos.filter((m) => m.type === 'credito');
    expect(creditos).toEqual([
      expect.objectContaining({ account: '130501', amount: 500000 }),
    ]);
  });

  it('siempre balanceado: el débito iguala la suma de los créditos', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      120000,
      380000,
      'RC',
    );
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.type === t).reduce((a, m) => a + m.amount, 0);

    expect(suma('debito')).toBe(suma('credito'));
    expect(suma('debito')).toBe(500000);
  });

  it('generaliza: con origen NC produce el mismo movimiento, distinta descripción', () => {
    const rc = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
    );
    const nc = construirAsientoCruce(
      '413595',
      '130501',
      '210505',
      200000,
      100000,
      'NC',
    );

    expect(nc.map((m) => ({ ...m, description: undefined }))).toEqual(
      rc.map((m) => ({
        ...m,
        account: m.account === '111005' ? '413595' : m.account,
        description: undefined,
      })),
    );
    expect(nc[0].description).not.toBe(rc[0].description);
  });
});

describe('construirMovimientosAplicacionAnticipo', () => {
  it('debita anticipos y acredita cartera por lo aplicado en esta llamada — nunca mueve la cuenta de origen', () => {
    const movimientos = construirMovimientosAplicacionAnticipo(
      '210505',
      '130501',
      150000,
      'RC',
    );

    expect(movimientos).toEqual([
      {
        account: '210505',
        type: 'debito',
        amount: 150000,
        description: expect.any(String),
      },
      {
        account: '130501',
        type: 'credito',
        amount: 150000,
        description: expect.any(String),
      },
    ]);
  });

  it('generaliza a NC con una descripción distinta, mismo movimiento', () => {
    const rc = construirMovimientosAplicacionAnticipo(
      '210505',
      '130501',
      150000,
      'RC',
    );
    const nc = construirMovimientosAplicacionAnticipo(
      '210505',
      '130501',
      150000,
      'NC',
    );

    expect(nc.map((m) => ({ ...m, description: undefined }))).toEqual(
      rc.map((m) => ({ ...m, description: undefined })),
    );
    expect(nc[0].description).not.toBe(rc[0].description);
  });
});

describe('construirContraAsientoCruce', () => {
  it('con aplicado y anticipo remanente, revierte ambas patas y devuelve el monto de origen completo', () => {
    const movimientos = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      300000,
      'RC',
    );

    expect(movimientos).toEqual([
      {
        account: '130501',
        type: 'debito',
        amount: 200000,
        description: expect.any(String),
      },
      {
        account: '210505',
        type: 'debito',
        amount: 100000,
        description: expect.any(String),
      },
      {
        account: '111005',
        type: 'credito',
        amount: 300000,
        description: expect.any(String),
      },
    ]);
  });

  it('un documento que era 100% anticipo revierte solo la pata de anticipos', () => {
    const movimientos = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      0,
      500000,
      500000,
      'RC',
    );

    expect(movimientos).toEqual([
      {
        account: '210505',
        type: 'debito',
        amount: 500000,
        description: expect.any(String),
      },
      {
        account: '111005',
        type: 'credito',
        amount: 500000,
        description: expect.any(String),
      },
    ]);
  });

  it('un documento totalmente aplicado revierte solo la pata de cartera', () => {
    const movimientos = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      500000,
      0,
      500000,
      'RC',
    );

    expect(movimientos).toEqual([
      {
        account: '130501',
        type: 'debito',
        amount: 500000,
        description: expect.any(String),
      },
      {
        account: '111005',
        type: 'credito',
        amount: 500000,
        description: expect.any(String),
      },
    ]);
  });

  it('siempre balanceado: los débitos igualan el crédito', () => {
    const movimientos = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      120000,
      380000,
      500000,
      'RC',
    );
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.type === t).reduce((a, m) => a + m.amount, 0);

    expect(suma('debito')).toBe(suma('credito'));
  });

  it('generaliza a NC con una descripción distinta, mismo movimiento', () => {
    const rc = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      300000,
      'RC',
    );
    const nc = construirContraAsientoCruce(
      '413595',
      '130501',
      '210505',
      200000,
      100000,
      300000,
      'NC',
    );

    expect(nc.map((m) => ({ ...m, description: undefined }))).toEqual(
      rc.map((m) => ({
        ...m,
        account: m.account === '111005' ? '413595' : m.account,
        description: undefined,
      })),
    );
    expect(nc[2].description).not.toBe(rc[2].description);
  });
});

describe('cuentasOrdenDe', () => {
  it('devuelve null cuando la copropiedad no usa cuentas de orden', () => {
    expect(
      cuentasOrdenDe({
        usesMemorandumAccounts: false,
        memorandumDebitAccount: '831505',
        memorandumCreditAccount: '831510',
      }),
    ).toBeNull();
    expect(cuentasOrdenDe(null)).toBeNull();
    expect(cuentasOrdenDe(undefined)).toBeNull();
  });

  it('resuelve el par cuando está habilitado, con reserva para cuentas sin asignar', () => {
    expect(
      cuentasOrdenDe({
        usesMemorandumAccounts: true,
        memorandumDebitAccount: '831505',
        memorandumCreditAccount: null,
      }),
    ).toEqual({ debito: '831505', credito: 'SIN-CUENTA-ASIGNADA' });
  });
});

describe('invertirCuentasOrden', () => {
  it('intercambia débito y crédito', () => {
    expect(
      invertirCuentasOrden({ debito: '831505', credito: '831510' }),
    ).toEqual({ debito: '831510', credito: '831505' });
  });

  it('preserva null', () => {
    expect(invertirCuentasOrden(null)).toBeNull();
  });
});

describe('construirAsientoCruce con cuentasOrden', () => {
  it('agrega el par por el monto total (aplicado + sin aplicar)', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
      { debito: '831505', credito: '831510' },
    );

    expect(movimientos).toHaveLength(5);
    expect(movimientos.find((m) => m.account === '831505')?.amount).toBe(
      300000,
    );
    expect(movimientos.find((m) => m.account === '831510')?.amount).toBe(
      300000,
    );
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.type === t).reduce((a, m) => a + m.amount, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });

  it('no agrega nada cuando no se provee', () => {
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
    );
    expect(movimientos).toHaveLength(3);
  });
});

describe('construirContraAsientoCruce con cuentasOrden', () => {
  it('revierte el par (lados invertidos) por el monto de origen', () => {
    const movimientos = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      300000,
      'RC',
      { debito: '831505', credito: '831510' },
    );

    expect(
      movimientos.find((m) => m.account === '831510' && m.type === 'debito')
        ?.amount,
    ).toBe(300000);
    expect(
      movimientos.find((m) => m.account === '831505' && m.type === 'credito')
        ?.amount,
    ).toBe(300000);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.type === t).reduce((a, m) => a + m.amount, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });
});

describe('construirMovimientosReclasificacion', () => {
  it('sin cuentasOrden produce solo el par de reclasificación', () => {
    const movimientos = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
    );
    expect(movimientos).toHaveLength(2);
  });

  it('con cuentasOrden agrega el par memo por el mismo monto', () => {
    const movimientos = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
      { debito: '831505', credito: '831510' },
    );

    expect(movimientos).toHaveLength(4);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.type === t).reduce((a, m) => a + m.amount, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });

  it('con cuentasOrden invertido (voiding) queda en la dirección contraria', () => {
    const creacion = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
      { debito: '831505', credito: '831510' },
    );
    const anulacion = construirMovimientosReclasificacion(
      '413502',
      '413501',
      100000,
      invertirCuentasOrden({ debito: '831505', credito: '831510' }),
    );

    const memoDe = (mov: typeof creacion) =>
      mov.filter((m) => m.account === '831505' || m.account === '831510');

    expect(memoDe(anulacion).find((m) => m.type === 'debito')?.account).toBe(
      memoDe(creacion).find((m) => m.type === 'credito')?.account,
    );
  });
});

describe('construirContraAsientoNotaDebito con cuentasOrden', () => {
  it('revierte el par (lados invertidos) por el monto', () => {
    const movimientos = construirContraAsientoNotaDebito(
      '130501',
      '413501',
      250000,
      { debito: '831505', credito: '831510' },
    );

    expect(
      movimientos.find((m) => m.account === '831510' && m.type === 'debito')
        ?.amount,
    ).toBe(250000);
    expect(
      movimientos.find((m) => m.account === '831505' && m.type === 'credito')
        ?.amount,
    ).toBe(250000);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.type === t).reduce((a, m) => a + m.amount, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });

  it('no agrega nada cuando no se provee', () => {
    const movimientos = construirContraAsientoNotaDebito(
      '130501',
      '413501',
      250000,
    );
    expect(movimientos).toHaveLength(2);
  });
});

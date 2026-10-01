import {
  construirMovimientos,
  enriquecerMovimientosConAuxiliares,
  construirAsientoCruce,
  construirMovimientosAplicacionAnticipo,
  construirContraAsientoCruce,
  construirContraAsientoAplicacionAnticipo,
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
        lineas: [{ cuentaIngreso: '413501', valorTotal: 520000 }],
      },
      '130501',
    );

    expect(movimientos).toEqual([
      {
        cuenta: '130501',
        tipo: 'debito',
        monto: 520000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '413501',
        tipo: 'credito',
        monto: 520000,
        descripcion: expect.any(String) as string,
      },
    ]);
  });

  it('genera un crédito por cada cuenta de ingreso distinta', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lineas: [
          { cuentaIngreso: '413501', valorTotal: 520000 },
          { cuentaIngreso: '413502', valorTotal: 200000 },
        ],
      },
      '130501',
    );

    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toHaveLength(2);
    expect(creditos.find((c) => c.cuenta === '413501')?.monto).toBe(520000);
    expect(creditos.find((c) => c.cuenta === '413502')?.monto).toBe(200000);
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
        lineas: [
          {
            nombreConcepto: 'Pintura',
            cuentaCartera: '130501',
            cuentaIngreso: '413501',
            valorTotal: 520000,
          },
          {
            nombreConcepto: 'Televisión por Cable',
            cuentaCartera: '130501',
            cuentaIngreso: '413501',
            valorTotal: 200000,
          },
        ],
      },
      '130501',
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    const creditos = movimientos.filter((m) => m.tipo === 'credito');

    expect(debitos).toHaveLength(2);
    expect(debitos.map((d) => d.monto).sort()).toEqual([200000, 520000]);
    expect(creditos).toHaveLength(2);
    expect(creditos.map((c) => c.monto).sort()).toEqual([200000, 520000]);

    // Aunque comparten cuenta, la descripción sigue distinguiendo cada
    // cargo — eso es lo que hace visible que son dos movimientos, no uno.
    expect(debitos.find((d) => d.monto === 520000)?.descripcion).toBe(
      'Pintura',
    );
    expect(debitos.find((d) => d.monto === 200000)?.descripcion).toBe(
      'Televisión por Cable',
    );
    expect(creditos.find((c) => c.monto === 520000)?.descripcion).toBe(
      'Pintura',
    );
    expect(creditos.find((c) => c.monto === 200000)?.descripcion).toBe(
      'Televisión por Cable',
    );
  });

  it('usa el nombre del cargo (pestaña Cargos) como descripción cuando la línea lo trae', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lineas: [
          {
            nombreConcepto: 'Administración',
            cuentaIngreso: '413501',
            valorTotal: 520000,
          },
        ],
      },
      '130501',
    );

    expect(movimientos.every((m) => m.descripcion === 'Administración')).toBe(
      true,
    );
  });

  it('cae a la descripción genérica cuando la línea no trae nombre de cargo (p. ej. Nota Débito)', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lineas: [{ cuentaIngreso: '413501', valorTotal: 520000 }],
      },
      '130501',
    );

    const debito = movimientos.find((m) => m.tipo === 'debito');
    const credito = movimientos.find((m) => m.tipo === 'credito');
    expect(debito?.descripcion).toBe('Cartera por cobrar — factura de venta');
    expect(credito?.descripcion).toBe('Ingreso por factura de venta');
  });

  it('respeta el invariante de partida doble: los débitos suman lo mismo que los créditos', () => {
    const movimientos = construirMovimientos(
      {
        total: 1013600,
        lineas: [
          { cuentaIngreso: '413501', valorTotal: 520000 },
          { cuentaIngreso: null, valorTotal: 493600 },
        ],
      },
      '130501',
    );

    const suma = (tipo: 'debito' | 'credito') =>
      movimientos
        .filter((m) => m.tipo === tipo)
        .reduce((acc, m) => acc + m.monto, 0);

    expect(suma('debito')).toBe(suma('credito'));
    expect(suma('debito')).toBe(1013600);
  });

  it('usa una cuenta de reserva cuando una línea no tiene cuenta contable asignada', () => {
    const movimientos = construirMovimientos(
      {
        total: 100000,
        lineas: [{ cuentaIngreso: null, valorTotal: 100000 }],
      },
      '130501',
    );

    const credito = movimientos.find((m) => m.tipo === 'credito');
    expect(credito?.cuenta).toBe('SIN-CUENTA-ASIGNADA');
  });

  it('codifica cada cargo con su propia cuenta aunque haya cuentasOrden, excepto el cargo de intereses', () => {
    // Corrige una lectura anterior (confirmada errónea con producto):
    // cuentasOrden NO reemplaza la codificación de toda la factura, solo la
    // de la línea de intereses por mora ("Cargo 2").
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lineas: [
          {
            tipoConcepto: 'administracion',
            cuentaIngreso: '413501',
            cuentaCartera: '130501',
            valorTotal: 520000,
          },
          {
            tipoConcepto: 'intereses',
            cuentaIngreso: '413599',
            cuentaCartera: '130599',
            valorTotal: 200000,
          },
        ],
      },
      '130501',
      { debito: '831505', credito: '831510' },
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    const creditos = movimientos.filter((m) => m.tipo === 'credito');

    expect(debitos.find((d) => d.cuenta === '130501')?.monto).toBe(520000);
    expect(debitos.find((d) => d.cuenta === '831505')?.monto).toBe(200000);
    expect(debitos.find((d) => d.cuenta === '130599')).toBeUndefined();

    expect(creditos.find((c) => c.cuenta === '413501')?.monto).toBe(520000);
    expect(creditos.find((c) => c.cuenta === '831510')?.monto).toBe(200000);
    expect(creditos.find((c) => c.cuenta === '413599')).toBeUndefined();

    const suma = (tipo: 'debito' | 'credito') =>
      movimientos
        .filter((m) => m.tipo === tipo)
        .reduce((acc, m) => acc + m.monto, 0);
    expect(suma('debito')).toBe(suma('credito'));
    expect(suma('debito')).toBe(720000);
  });

  it('el nombre del cargo gana sobre el texto genérico de cuentas de orden', () => {
    const movimientos = construirMovimientos(
      {
        total: 200000,
        lineas: [
          {
            tipoConcepto: 'intereses',
            nombreConcepto: 'Intereses por Mora',
            cuentaIngreso: '413599',
            cuentaCartera: '130599',
            valorTotal: 200000,
          },
        ],
      },
      '130501',
      { debito: '831505', credito: '831510' },
    );

    expect(
      movimientos.every((m) => m.descripcion === 'Intereses por Mora'),
    ).toBe(true);
  });

  it('codifica el cargo de intereses con su propia cuenta cuando no hay cuentasOrden', () => {
    const movimientos = construirMovimientos(
      {
        total: 200000,
        lineas: [
          {
            tipoConcepto: 'intereses',
            cuentaIngreso: '413599',
            cuentaCartera: '130599',
            valorTotal: 200000,
          },
        ],
      },
      '130501',
      null,
    );

    expect(movimientos).toEqual([
      {
        cuenta: '130599',
        tipo: 'debito',
        monto: 200000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '413599',
        tipo: 'credito',
        monto: 200000,
        descripcion: expect.any(String) as string,
      },
    ]);
  });

  it('omite las cuentas de orden cuando no se proveen', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lineas: [{ cuentaIngreso: '413501', valorTotal: 520000 }],
      },
      '130501',
      null,
    );

    expect(movimientos).toHaveLength(2);
  });

  it('debita la cuenta propia de cada concepto cuando la línea trae cuentaCartera', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lineas: [
          {
            cuentaIngreso: '413501',
            cuentaCartera: '130501',
            valorTotal: 520000,
          },
          {
            cuentaIngreso: '413502',
            cuentaCartera: '130502',
            valorTotal: 200000,
          },
        ],
      },
      '130501',
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.find((d) => d.cuenta === '130501')?.monto).toBe(520000);
    expect(debitos.find((d) => d.cuenta === '130502')?.monto).toBe(200000);

    const suma = (tipo: 'debito' | 'credito') =>
      movimientos
        .filter((m) => m.tipo === tipo)
        .reduce((acc, m) => acc + m.monto, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });

  it('cae a cuentaCartera cuando una línea no trae cuentaCartera propio', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lineas: [
          {
            cuentaIngreso: '413501',
            cuentaCartera: '130502',
            valorTotal: 520000,
          },
          { cuentaIngreso: '413502', valorTotal: 200000 },
        ],
      },
      '130501',
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.find((d) => d.cuenta === '130502')?.monto).toBe(520000);
    expect(debitos.find((d) => d.cuenta === '130501')?.monto).toBe(200000);
  });

  it('NO fusiona dos líneas que comparten la misma cuenta de débito: un movimiento por línea', () => {
    const movimientos = construirMovimientos(
      {
        total: 720000,
        lineas: [
          {
            cuentaIngreso: '413501',
            cuentaCartera: '130502',
            valorTotal: 520000,
          },
          {
            cuentaIngreso: '413502',
            cuentaCartera: '130502',
            valorTotal: 200000,
          },
        ],
      },
      '130501',
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.every((d) => d.cuenta === '130502')).toBe(true);
    expect(debitos.map((d) => d.monto).sort()).toEqual([200000, 520000]);
  });

  it('con valorImpuesto > 0, separa el crédito en base (ingreso) e impuesto (cuenta propia), sin tocar el débito', () => {
    const movimientos = construirMovimientos(
      {
        total: 119000,
        lineas: [
          {
            cuentaIngreso: '413501',
            cuentaCartera: '130501',
            cuentaImpuesto: '240815',
            valorTotal: 119000,
            valorImpuesto: 19000,
          },
        ],
      },
      '130501',
    );

    expect(movimientos).toHaveLength(3);
    const debito = movimientos.find((m) => m.tipo === 'debito');
    expect(debito).toMatchObject({ cuenta: '130501', monto: 119000 });

    const creditoIngreso = movimientos.find(
      (m) => m.tipo === 'credito' && m.cuenta === '413501',
    );
    expect(creditoIngreso).toMatchObject({ monto: 100000 });

    const creditoImpuesto = movimientos.find(
      (m) => m.tipo === 'credito' && m.cuenta === '240815',
    );
    expect(creditoImpuesto).toMatchObject({
      monto: 19000,
      baseGravable: 100000,
    });
  });

  it('sin cuentaImpuestoId configurada, el crédito del impuesto cae en CUENTA_SIN_ASIGNAR', () => {
    const movimientos = construirMovimientos(
      {
        total: 119000,
        lineas: [
          {
            cuentaIngreso: '413501',
            valorTotal: 119000,
            valorImpuesto: 19000,
            cuentaImpuesto: null,
          },
        ],
      },
      '130501',
    );

    const creditoImpuesto = movimientos.find(
      (m) => m.tipo === 'credito' && m.monto === 19000,
    );
    expect(creditoImpuesto?.cuenta).toBe('SIN-CUENTA-ASIGNADA');
  });

  it('con valorImpuesto 0 (u omitido), mantiene el comportamiento actual: un solo crédito por el total', () => {
    const movimientos = construirMovimientos(
      {
        total: 520000,
        lineas: [{ cuentaIngreso: '413501', valorTotal: 520000 }],
      },
      '130501',
    );

    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toEqual([
      expect.objectContaining({ cuenta: '413501', monto: 520000 }),
    ]);
  });
});

describe('enriquecerMovimientosConAuxiliares', () => {
  const movimientoBase = (
    over: Partial<ReturnType<typeof construirMovimientos>[number]> = {},
  ) => ({
    cuenta: '130501',
    tipo: 'debito' as const,
    monto: 100000,
    descripcion: 'algo',
    ...over,
  });

  it('agrega tercero solo a las líneas cuya cuenta lo requiere', () => {
    const movimientos = [
      movimientoBase({ cuenta: '130501' }),
      movimientoBase({ cuenta: '413501' }),
    ];
    const cuentasPorCodigo = new Map([
      [
        '130501',
        {
          requiereTercero: true,
          centroUtilidad: false,
          centroDestino: false,
          flujoCaja: false,
          requiereDocumentoCruce: false,
        },
      ],
      [
        '413501',
        {
          requiereTercero: false,
          centroUtilidad: false,
          centroDestino: false,
          flujoCaja: false,
          requiereDocumentoCruce: false,
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
          requiereDocumentoCruce: false,
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
          requiereDocumentoCruce: false,
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
    const movimientos = [movimientoBase({ cuenta: 'SIN-CUENTA-ASIGNADA' })];

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

    const debito = movimientos.find((m) => m.cuenta === '111005');
    expect(debito).toMatchObject({ tipo: 'debito', monto: 300000 });
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
        cuenta: '111005',
        tipo: 'debito',
        monto: 300000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '130501',
        tipo: 'credito',
        monto: 200000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '210505',
        tipo: 'credito',
        monto: 100000,
        descripcion: expect.any(String) as string,
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
        cuenta: '111005',
        tipo: 'debito',
        monto: 500000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '210505',
        tipo: 'credito',
        monto: 500000,
        descripcion: expect.any(String) as string,
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
        cuenta: '111005',
        tipo: 'debito',
        monto: 500000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '130501',
        tipo: 'credito',
        monto: 500000,
        descripcion: expect.any(String) as string,
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
        { cuenta: '130510', monto: 300000 },
        { cuenta: '130520', monto: 200000 },
      ],
    );

    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toHaveLength(2);
    expect(creditos.find((c) => c.cuenta === '130510')?.monto).toBe(300000);
    expect(creditos.find((c) => c.cuenta === '130520')?.monto).toBe(200000);
    expect(creditos.some((c) => c.cuenta === '130501')).toBe(false);
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
        { cuenta: '130510', monto: 300000 },
        { cuenta: '130510', monto: 200000 },
      ],
    );

    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toHaveLength(1);
    expect(creditos[0]).toMatchObject({ cuenta: '130510', monto: 500000 });
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

    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toEqual([
      expect.objectContaining({ cuenta: '130501', monto: 500000 }),
    ]);
  });

  it('con desgloseOrigen, debita cada cuenta propia en vez de la cuenta plana de origen (Nota Crédito reversando ingreso por concepto)', () => {
    const movimientos = construirAsientoCruce(
      '413595',
      '130501',
      '210505',
      100000,
      0,
      'NC',
      null,
      undefined,
      undefined,
      undefined,
      [
        { cuenta: '413501', monto: 70000 },
        { cuenta: '413502', monto: 30000 },
      ],
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.find((d) => d.cuenta === '413501')?.monto).toBe(70000);
    expect(debitos.find((d) => d.cuenta === '413502')?.monto).toBe(30000);
    expect(debitos.some((d) => d.cuenta === '413595')).toBe(false);
  });

  it('un desgloseOrigen vacío cae a la cuenta plana de origen', () => {
    const movimientos = construirAsientoCruce(
      '413595',
      '130501',
      '210505',
      100000,
      0,
      'NC',
      null,
      undefined,
      undefined,
      undefined,
      [],
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    expect(debitos).toEqual([
      expect.objectContaining({ cuenta: '413595', monto: 100000 }),
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
      movimientos.filter((m) => m.tipo === t).reduce((a, m) => a + m.monto, 0);

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

    expect(nc.map((m) => ({ ...m, descripcion: undefined }))).toEqual(
      rc.map((m) => ({
        ...m,
        cuenta: m.cuenta === '111005' ? '413595' : m.cuenta,
        descripcion: undefined,
      })),
    );
    expect(nc[0].descripcion).not.toBe(rc[0].descripcion);
  });

  it('con descuento, reduce el débito de origen y agrega un débito a la cuenta de descuentos — sigue cuadrando', () => {
    // Factura de 400000: el cliente consignó 360000, el descuento (40000) la
    // salda completa — montoAplicado ya viene con el descuento sumado.
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      400000,
      0,
      'RC',
      undefined,
      undefined,
      undefined,
      { cuenta: '540501', monto: 40000 },
    );

    expect(movimientos).toEqual([
      {
        cuenta: '111005',
        tipo: 'debito',
        monto: 360000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '540501',
        tipo: 'debito',
        monto: 40000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '130501',
        tipo: 'credito',
        monto: 400000,
        descripcion: expect.any(String) as string,
      },
    ]);
    const debitos = movimientos
      .filter((m) => m.tipo === 'debito')
      .reduce((acc, m) => acc + m.monto, 0);
    const creditos = movimientos
      .filter((m) => m.tipo === 'credito')
      .reduce((acc, m) => acc + m.monto, 0);
    expect(debitos).toBe(creditos);
  });

  it('sin descuento (parámetro omitido), el comportamiento es idéntico al de antes de este parámetro', () => {
    const conParametroEnCero = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
      undefined,
      undefined,
      undefined,
      { cuenta: '540501', monto: 0 },
    );
    const sinParametro = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
    );
    expect(conParametroEnCero).toEqual(sinParametro);
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
        cuenta: '210505',
        tipo: 'debito',
        monto: 150000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '130501',
        tipo: 'credito',
        monto: 150000,
        descripcion: expect.any(String) as string,
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

    expect(nc.map((m) => ({ ...m, descripcion: undefined }))).toEqual(
      rc.map((m) => ({ ...m, descripcion: undefined })),
    );
    expect(nc[0].descripcion).not.toBe(rc[0].descripcion);
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
        cuenta: '130501',
        tipo: 'debito',
        monto: 200000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '210505',
        tipo: 'debito',
        monto: 100000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '111005',
        tipo: 'credito',
        monto: 300000,
        descripcion: expect.any(String) as string,
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
        cuenta: '210505',
        tipo: 'debito',
        monto: 500000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '111005',
        tipo: 'credito',
        monto: 500000,
        descripcion: expect.any(String) as string,
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
        cuenta: '130501',
        tipo: 'debito',
        monto: 500000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '111005',
        tipo: 'credito',
        monto: 500000,
        descripcion: expect.any(String) as string,
      },
    ]);
  });

  it('con desgloseOrigen, acredita cada cuenta propia en vez de la cuenta plana de origen (reversa cada ingreso de la Nota Crédito que lo debitó)', () => {
    const movimientos = construirContraAsientoCruce(
      '413595',
      '130501',
      '210505',
      100000,
      0,
      100000,
      'NC',
      null,
      undefined,
      undefined,
      undefined,
      [
        { cuenta: '413501', monto: 70000 },
        { cuenta: '413502', monto: 30000 },
      ],
    );

    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toHaveLength(2);
    expect(creditos.find((c) => c.cuenta === '413501')?.monto).toBe(70000);
    expect(creditos.find((c) => c.cuenta === '413502')?.monto).toBe(30000);
    expect(creditos.some((c) => c.cuenta === '413595')).toBe(false);
  });

  it('un desgloseOrigen vacío cae a la cuenta plana de origen', () => {
    const movimientos = construirContraAsientoCruce(
      '413595',
      '130501',
      '210505',
      100000,
      0,
      100000,
      'NC',
      null,
      undefined,
      undefined,
      undefined,
      [],
    );

    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toEqual([
      expect.objectContaining({ cuenta: '413595', monto: 100000 }),
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
      movimientos.filter((m) => m.tipo === t).reduce((a, m) => a + m.monto, 0);

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

    expect(nc.map((m) => ({ ...m, descripcion: undefined }))).toEqual(
      rc.map((m) => ({
        ...m,
        cuenta: m.cuenta === '111005' ? '413595' : m.cuenta,
        descripcion: undefined,
      })),
    );
    expect(nc[2].descripcion).not.toBe(rc[2].descripcion);
  });

  it('con descuento, agrega un crédito de reversión a la cuenta de descuentos — sigue cuadrando', () => {
    // Espejo del ejemplo de construirAsientoCruce: 400000 se habían
    // acreditado a cartera (360000 cash + 40000 descuento); montoOrigen
    // (receivedAmount cacheado) es 360000, el dinero real.
    const movimientos = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      400000,
      0,
      360000,
      'RC',
      undefined,
      undefined,
      undefined,
      { cuenta: '540502', monto: 40000 },
    );

    expect(movimientos).toEqual([
      {
        cuenta: '130501',
        tipo: 'debito',
        monto: 400000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '111005',
        tipo: 'credito',
        monto: 360000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '540502',
        tipo: 'credito',
        monto: 40000,
        descripcion: expect.any(String) as string,
      },
    ]);
    const debitos = movimientos
      .filter((m) => m.tipo === 'debito')
      .reduce((acc, m) => acc + m.monto, 0);
    const creditos = movimientos
      .filter((m) => m.tipo === 'credito')
      .reduce((acc, m) => acc + m.monto, 0);
    expect(debitos).toBe(creditos);
  });
});

describe('cuentasOrdenDe', () => {
  it('devuelve null cuando la copropiedad no usa cuentas de orden', () => {
    expect(
      cuentasOrdenDe({
        usaCuentasOrden: false,
        cuentaOrdenDebito: '831505',
        cuentaOrdenCredito: '831510',
      }),
    ).toBeNull();
    expect(cuentasOrdenDe(null)).toBeNull();
    expect(cuentasOrdenDe(undefined)).toBeNull();
  });

  it('resuelve el par cuando está habilitado, con reserva para cuentas sin asignar', () => {
    expect(
      cuentasOrdenDe({
        usaCuentasOrden: true,
        cuentaOrdenDebito: '831505',
        cuentaOrdenCredito: null,
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
    expect(movimientos.find((m) => m.cuenta === '831505')?.monto).toBe(300000);
    expect(movimientos.find((m) => m.cuenta === '831510')?.monto).toBe(300000);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.tipo === t).reduce((a, m) => a + m.monto, 0);
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

  it('con montoCuentasOrden, escala el par al monto explícito en vez del total del documento', () => {
    // Un recibo de 300.000 donde solo 40.000 tocaron un cargo de mora — el
    // par de cuentas de orden debe reflejar ESE monto, no los 300.000
    // completos (el bug que este cambio corrige).
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
      { debito: '831505', credito: '831510' },
      undefined,
      40000,
    );

    expect(movimientos.find((m) => m.cuenta === '831505')?.monto).toBe(40000);
    expect(movimientos.find((m) => m.cuenta === '831510')?.monto).toBe(40000);
  });

  it('con montoCuentasOrden en 0, no agrega el par aunque cuentasOrden esté configurado', () => {
    // Un recibo que nunca tocó un cargo de mora no debe dejar un par de
    // cuentas de orden en cero sentado en el libro.
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      'RC',
      { debito: '831505', credito: '831510' },
      undefined,
      0,
    );

    expect(movimientos.some((m) => m.cuenta === '831505')).toBe(false);
    expect(movimientos.some((m) => m.cuenta === '831510')).toBe(false);
  });

  it('postea el par con los lados INVERTIDOS respecto a facturacion — cobrar la mora cierra el memo que invoicing abrio', () => {
    // Facturación abre el par al invoicing la mora: debito en `debito`,
    // credito en `credito` (ver `construirMovimientos`). Un recibo que
    // cobra esa misma mora debe cerrarlo, no repetirlo — de lo contrario
    // el par se dobla en vez de quedar en cero quando ambos eventos ya
    // ocurrieron. Reportado por el usuario tras confirmar en producción.
    const movimientos = construirAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      0,
      'RC',
      { debito: '831505', credito: '831510' },
    );

    expect(movimientos.find((m) => m.cuenta === '831505')?.tipo).toBe(
      'credito',
    );
    expect(movimientos.find((m) => m.cuenta === '831510')?.tipo).toBe('debito');
  });
});

describe('construirContraAsientoCruce con cuentasOrden', () => {
  it('revierte el par de vuelta a los lados planos de facturacion (la creacion ya los invirtio) por el monto de origen', () => {
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
      movimientos.find((m) => m.cuenta === '831505' && m.tipo === 'debito')
        ?.monto,
    ).toBe(300000);
    expect(
      movimientos.find((m) => m.cuenta === '831510' && m.tipo === 'credito')
        ?.monto,
    ).toBe(300000);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.tipo === t).reduce((a, m) => a + m.monto, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });

  it('con montoCuentasOrden, revierte solo la porción de mora, no el monto de origen completo', () => {
    const movimientos = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      200000,
      100000,
      300000,
      'RC',
      { debito: '831505', credito: '831510' },
      undefined,
      40000,
    );

    expect(
      movimientos.find((m) => m.cuenta === '831505' && m.tipo === 'debito')
        ?.monto,
    ).toBe(40000);
    expect(
      movimientos.find((m) => m.cuenta === '831510' && m.tipo === 'credito')
        ?.monto,
    ).toBe(40000);
  });

  it('con desgloseCartera, debita cada cuenta propia en vez de la cuenta plana de cartera', () => {
    const movimientos = construirContraAsientoCruce(
      '111005',
      '130501',
      '210505',
      500000,
      0,
      500000,
      'RC',
      null,
      [
        { cuenta: '130510', monto: 300000 },
        { cuenta: '130520', monto: 200000 },
      ],
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.find((d) => d.cuenta === '130510')?.monto).toBe(300000);
    expect(debitos.find((d) => d.cuenta === '130520')?.monto).toBe(200000);
    expect(debitos.some((d) => d.cuenta === '130501')).toBe(false);
  });
});

describe('construirMovimientosAplicacionAnticipo con desglose y cuentasOrden', () => {
  it('sin desglose ni cuentasOrden, mantiene el comportamiento plano de siempre', () => {
    const movimientos = construirMovimientosAplicacionAnticipo(
      '210505',
      '130501',
      200000,
      'RC',
    );
    expect(movimientos).toEqual([
      {
        cuenta: '210505',
        tipo: 'debito',
        monto: 200000,
        descripcion: expect.any(String) as string,
      },
      {
        cuenta: '130501',
        tipo: 'credito',
        monto: 200000,
        descripcion: expect.any(String) as string,
      },
    ]);
  });

  it('con desgloseCartera, acredita cada cuenta propia del concepto', () => {
    const movimientos = construirMovimientosAplicacionAnticipo(
      '210505',
      '130501',
      200000,
      'RC',
      [{ cuenta: '130599', monto: 200000 }],
    );
    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toEqual([
      expect.objectContaining({ cuenta: '130599', monto: 200000 }),
    ]);
  });

  it('con montoCuentasOrden, agrega el par memo por la porción de mora aplicada después', () => {
    const movimientos = construirMovimientosAplicacionAnticipo(
      '210505',
      '130501',
      200000,
      'RC',
      [{ cuenta: '130599', monto: 200000 }],
      { debito: '831505', credito: '831510' },
      50000,
    );

    expect(movimientos.find((m) => m.cuenta === '831505')?.monto).toBe(50000);
    expect(movimientos.find((m) => m.cuenta === '831510')?.monto).toBe(50000);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.tipo === t).reduce((a, m) => a + m.monto, 0);
    expect(suma('debito')).toBe(suma('credito'));
    // Same swapped-sides direction as `construirAsientoCruce` — a deferred
    // application closing mora is the same kind of event as an immediate one.
    expect(movimientos.find((m) => m.cuenta === '831505')?.tipo).toBe(
      'credito',
    );
    expect(movimientos.find((m) => m.cuenta === '831510')?.tipo).toBe('debito');
  });

  it('sin montoCuentasOrden, no agrega ningún par memo aunque cuentasOrden esté configurado', () => {
    const movimientos = construirMovimientosAplicacionAnticipo(
      '210505',
      '130501',
      200000,
      'RC',
      undefined,
      { debito: '831505', credito: '831510' },
    );
    expect(movimientos).toHaveLength(2);
  });

  it("con origen 'NA', usa las descripciones de Nota de Anticipo", () => {
    const movimientos = construirMovimientosAplicacionAnticipo(
      '210505',
      '130501',
      200000,
      'NA',
    );
    expect(movimientos[0].descripcion).toBe(
      'Anticipo aplicado a cartera — nota de anticipo',
    );
    expect(movimientos[1].descripcion).toBe(
      'Cartera por cobrar — aplicación de nota de anticipo',
    );
  });
});

describe('construirContraAsientoAplicacionAnticipo', () => {
  it('revierte los lados planos: debito cartera (por desglose), credito anticipos, por el monto total', () => {
    const movimientos = construirContraAsientoAplicacionAnticipo(
      '210505',
      '130501',
      200000,
      'NA',
      [
        { cuenta: '130510', monto: 120000 },
        { cuenta: '130520', monto: 80000 },
      ],
    );

    const debitos = movimientos.filter((m) => m.tipo === 'debito');
    expect(debitos).toHaveLength(2);
    expect(debitos.find((d) => d.cuenta === '130510')?.monto).toBe(120000);
    expect(debitos.find((d) => d.cuenta === '130520')?.monto).toBe(80000);

    const creditos = movimientos.filter((m) => m.tipo === 'credito');
    expect(creditos).toHaveLength(1);
    expect(creditos[0]).toMatchObject({ cuenta: '210505', monto: 200000 });

    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.tipo === t).reduce((a, m) => a + m.monto, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });

  it('sin desgloseCartera, debita la cuenta de cartera compartida', () => {
    const movimientos = construirContraAsientoAplicacionAnticipo(
      '210505',
      '130501',
      100000,
      'NA',
    );
    expect(
      movimientos.find((m) => m.tipo === 'debito' && m.cuenta === '130501')
        ?.monto,
    ).toBe(100000);
  });

  it('con cuentasOrden, revierte el par de vuelta a los lados planos de facturacion (la creacion ya los invirtio)', () => {
    const movimientos = construirContraAsientoAplicacionAnticipo(
      '210505',
      '130501',
      100000,
      'NA',
      undefined,
      { debito: '831505', credito: '831510' },
      40000,
    );
    expect(movimientos.find((m) => m.cuenta === '831505')?.tipo).toBe('debito');
    expect(movimientos.find((m) => m.cuenta === '831510')?.tipo).toBe(
      'credito',
    );
    expect(movimientos.find((m) => m.cuenta === '831505')?.monto).toBe(40000);
  });

  it('sin cuentasOrden no agrega ningún par memo', () => {
    const movimientos = construirContraAsientoAplicacionAnticipo(
      '210505',
      '130501',
      100000,
      'NA',
    );
    expect(movimientos).toHaveLength(2);
  });
});

describe('construirMovimientosReclasificacion', () => {
  it('acredita la cuenta origen y debita la cuenta destino — vista de cartera, no de ingreso', () => {
    const movimientos = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
    );

    expect(movimientos).toEqual([
      expect.objectContaining({
        cuenta: '413501',
        tipo: 'credito',
        monto: 100000,
      }),
      expect.objectContaining({
        cuenta: '413502',
        tipo: 'debito',
        monto: 100000,
      }),
    ]);
  });

  it('sin cuentasOrden produce solo el par de reclasificación', () => {
    const movimientos = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
    );
    expect(movimientos).toHaveLength(2);
  });

  it('sin origen/destino de intereses, NO mueve cuentasOrden aunque esté configurado', () => {
    // Regresión: antes de recibir `origenEsIntereses`/`destinoEsIntereses`,
    // esta función movía el par memo por el monto completo cada vez que
    // `cuentasOrden` estaba configurado, sin importar el concepto —
    // Administración → Otro nunca debe tocar el par memo.
    const movimientos = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
      { debito: '831505', credito: '831510' },
    );

    expect(movimientos).toHaveLength(2);
  });

  it('con destino de intereses, agrega el par memo por el mismo monto (abre el par, como facturación)', () => {
    const movimientos = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
      { debito: '831505', credito: '831510' },
      false,
      true,
    );

    expect(movimientos).toHaveLength(4);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.tipo === t).reduce((a, m) => a + m.monto, 0);
    expect(suma('debito')).toBe(suma('credito'));
  });

  it('con origen de intereses, cierra el par memo en la dirección contraria (como un cruce cobrando mora)', () => {
    const movimientos = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
      { debito: '831505', credito: '831510' },
      true,
      false,
    );

    // Dirección invertida respecto a "destino de intereses": la cuenta que
    // ahí quedaba en débito ('831505') aquí queda en crédito, y viceversa.
    const memo831505 = movimientos.find((m) => m.cuenta === '831505');
    const memo831510 = movimientos.find((m) => m.cuenta === '831510');
    expect(memo831505?.tipo).toBe('credito');
    expect(memo831510?.tipo).toBe('debito');
  });

  it('anular una reclasificación que abrió el par memo lo revierte, sin invertir cuentasOrden manualmente', () => {
    // El swap de roles (origen/destino, y sus banderas de intereses) al
    // anular ya reversa el par memo por sí solo — pasar `cuentasOrden`
    // pre-invertido encima (como hacía la primera versión de este builder)
    // lo revertiría dos veces, dejándolo apuntando otra vez mal.
    const creacion = construirMovimientosReclasificacion(
      '413501',
      '413502',
      100000,
      { debito: '831505', credito: '831510' },
      false,
      true,
    );
    const anulacion = construirMovimientosReclasificacion(
      '413502',
      '413501',
      100000,
      { debito: '831505', credito: '831510' },
      true,
      false,
    );

    const memoDe = (mov: typeof creacion) =>
      mov.filter((m) => m.cuenta === '831505' || m.cuenta === '831510');

    expect(memoDe(anulacion).find((m) => m.tipo === 'debito')?.cuenta).toBe(
      memoDe(creacion).find((m) => m.tipo === 'credito')?.cuenta,
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
      movimientos.find((m) => m.cuenta === '831510' && m.tipo === 'debito')
        ?.monto,
    ).toBe(250000);
    expect(
      movimientos.find((m) => m.cuenta === '831505' && m.tipo === 'credito')
        ?.monto,
    ).toBe(250000);
    const suma = (t: 'debito' | 'credito') =>
      movimientos.filter((m) => m.tipo === t).reduce((a, m) => a + m.monto, 0);
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

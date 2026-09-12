import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  ajustarSaldosCartera,
  ajustarSaldosCarteraPorDistribucion,
  decrementarSaldoFactura,
  decrementarSaldoNotaDebito,
  evaluarAplicacionConDescuento,
  remanentesPorLinea,
  validarDistribucionManual,
} from './cruce.util';

const SESSION = { id: 'fake-session' } as never;
const COP = new Types.ObjectId();

// Shared no-op mock for `ajustarSaldosCartera`/`ajustarSaldosCarteraPorDistribucion`'s
// new `CarteraPorDocumento` writes — none of the tests below assert on it,
// they only care about `SaldoCartera`'s own `saldos` mock.
const carteraPorDocumentoMock = () => ({
  findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
});

/** A `SaldoTotalDocumento` model mock whose `findOneAndUpdate` replays the
 *  real `$expr`-guarded atomic decrement against an in-memory `saldo` —
 *  same simulation style the old tests ran directly against `facturas`,
 *  moved here since that's where the guard itself now lives. */
const saldoTotalDocumentoCon = (saldoInicial: number) => {
  let saldo = saldoInicial;
  return {
    mock: {
      findOneAndUpdate: jest.fn(
        (
          filtro: Record<string, unknown>,
          _actualizacion?: unknown,
          _opciones?: unknown,
        ) => ({
          exec: () => {
            const expr = filtro.$expr as { $gte: [string, number] };
            const monto = expr.$gte[1];
            if (saldo < monto) return Promise.resolve(null);
            saldo -= monto;
            return Promise.resolve({
              documentoId: filtro.documentoId,
              saldoPendiente: saldo,
            });
          },
        }),
      ),
    },
    saldoActual: () => saldo,
  };
};

describe('decrementarSaldoFactura', () => {
  const facturaId = new Types.ObjectId();
  const facturaDoc = {
    _id: facturaId,
    inmuebleId: new Types.ObjectId(),
    total: 500000,
    lines: [],
  };
  const facturasCon = (doc: unknown = facturaDoc) => ({
    findOne: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(doc) }),
    })),
  });

  it('descuenta el monto cuando el saldo alcanza', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(500000);
    const facturas = facturasCon();

    const resultado = await decrementarSaldoFactura(
      facturas as never,
      saldoTotalDocumento as never,
      SESSION,
      COP,
      facturaId,
      200000,
    );

    expect(resultado.outstandingBalance).toBe(300000);
    expect(resultado._id).toEqual(facturaId);
  });

  it('rechaza cuando el monto excede el saldo pendiente — la guarda $expr', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(500000);
    const facturas = facturasCon();

    await expect(
      decrementarSaldoFactura(
        facturas as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        facturaId,
        999999,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('la guarda es una sola operación atómica ($expr + $inc en el mismo findOneAndUpdate, contra SaldoTotalDocumento)', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(100);
    const facturas = facturasCon();

    await decrementarSaldoFactura(
      facturas as never,
      saldoTotalDocumento as never,
      SESSION,
      COP,
      facturaId,
      50,
    );

    expect(saldoTotalDocumento.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro, actualizacion, opciones] =
      saldoTotalDocumento.findOneAndUpdate.mock.calls[0];
    expect(filtro).toMatchObject({
      documentoId: facturaId,
      $expr: { $gte: ['$saldoPendiente', 50] },
    });
    expect(actualizacion).toEqual({ $inc: { saldoPendiente: -50 } });
    expect(opciones).toMatchObject({ session: SESSION });
  });

  it('rechaza un monto negativo sin tocar la base de datos — jamás un crédito disfrazado de descuento', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(500000);
    const facturas = facturasCon();

    await expect(
      decrementarSaldoFactura(
        facturas as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        facturaId,
        -50,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(saldoTotalDocumento.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rechaza un monto cero sin tocar la base de datos', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(500000);
    const facturas = facturasCon();

    await expect(
      decrementarSaldoFactura(
        facturas as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        facturaId,
        0,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(saldoTotalDocumento.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rechaza NaN e Infinity sin tocar la base de datos — nunca envenenar el saldo autoritativo', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(500000);
    const facturas = facturasCon();

    await expect(
      decrementarSaldoFactura(
        facturas as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        facturaId,
        NaN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      decrementarSaldoFactura(
        facturas as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        facturaId,
        Infinity,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(saldoTotalDocumento.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('concurrencia: dos aplicaciones simultáneas contra la misma factura nunca la descuentan doble', async () => {
    // Simula el estado real de Mongo: cada findOneAndUpdate ve el resultado
    // de la anterior, igual que "avanza uno y nunca repite" en
    // numeracion.service.spec.ts — JS es de un solo hilo, así que
    // Promise.all no paraleliza de verdad, pero SÍ ejercita el orden en que
    // dos llamadas concurrentes entrelazarían sus `await` reales.
    const { mock: saldoTotalDocumento, saldoActual } =
      saldoTotalDocumentoCon(300000);
    const facturas = facturasCon();

    const resultados = await Promise.allSettled([
      decrementarSaldoFactura(
        facturas as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        facturaId,
        200000,
      ),
      decrementarSaldoFactura(
        facturas as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        facturaId,
        200000,
      ),
    ]);

    const cumplidas = resultados.filter((r) => r.status === 'fulfilled');
    expect(cumplidas).toHaveLength(1);
    expect(saldoActual()).toBe(100000);
  });
});

describe('ajustarSaldosCartera', () => {
  const inmuebleId = new Types.ObjectId();
  const conceptoA = new Types.ObjectId();
  const conceptoB = new Types.ObjectId();

  it('aplica primero a la línea MÁS RECIENTE (la última del arreglo, mayor sortOrder), nunca proporcional', async () => {
    const llamadas: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (
          filtro: Record<string, unknown>,
          pipeline: unknown,
          _opciones?: unknown,
        ) => {
          llamadas.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };

    // `lines` llega ordenado por sortOrder ascendente (conceptoA = el más
    // antiguo, p.ej. Administración); un pago parcial debe agotar PRIMERO
    // conceptoB (el último del arreglo) antes de tocar conceptoA siquiera.
    await ajustarSaldosCartera(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      {
        _id: new Types.ObjectId(),
        inmuebleId,
        total: 500000,
        outstandingBalance: 400000, // primer pago de esta factura: 500000 → 400000
        lines: [
          { conceptoId: conceptoA, totalAmount: 400000 },
          { conceptoId: conceptoB, totalAmount: 100000 },
        ],
      },
      100000,
      -1,
    );

    // Solo UNA llamada: conceptoB absorbe el pago completo, conceptoA ni se
    // toca — nada de "80/20 proporcional".
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0][0]).toMatchObject({ conceptoId: conceptoB });
    expect(llamadas[0][1]).toEqual([
      {
        $set: {
          coPropertyId: { $ifNull: ['$coPropertyId', COP] },
          inmuebleId: { $ifNull: ['$inmuebleId', inmuebleId] },
          conceptoId: { $ifNull: ['$conceptoId', conceptoB] },
          balance: {
            $max: [0, { $add: [{ $ifNull: ['$balance', 0] }, -100000] }],
          },
        },
      },
    ]);
    const [, , opciones] = saldos.findOneAndUpdate.mock.calls[0];
    // `updatePipeline: true` es obligatorio en Mongoose 9 para pasar un
    // array (pipeline de agregación, necesario acá para $max/$add contra el
    // propio valor del documento) como update — sin esto, Mongoose lanza
    // "Cannot pass an array to query updates..." en tiempo de ejecución, algo
    // que un mock de findOneAndUpdate nunca detecta por su cuenta. `upsert`
    // — ver el docblock de `ajustarCarteraPorDocumento` sobre por qué una
    // fila ausente nunca debe quedar en silencio sin crearse.
    expect(opciones).toMatchObject({
      session: SESSION,
      updatePipeline: true,
      upsert: true,
    });
  });

  it('devuelve el mismo desglose por concepto que aplicó — para que el asiento use la misma cuenta', async () => {
    const saldos = {
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };

    const partes = await ajustarSaldosCartera(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      {
        _id: new Types.ObjectId(),
        inmuebleId,
        total: 500000,
        outstandingBalance: 400000,
        lines: [
          { conceptoId: conceptoA, totalAmount: 400000 },
          { conceptoId: conceptoB, totalAmount: 100000 },
        ],
      },
      100000,
      -1,
    );

    expect(partes).toEqual([{ conceptoId: conceptoB, parte: 100000 }]);
  });

  it('un segundo pago retoma donde quedó el primero, sin volver a llenar un bucket ya agotado', async () => {
    // Factura de 100000: Multas (20000, sortOrder más alto → se llena
    // primero) y Administración (80000, sortOrder más bajo → de última).
    // Primer pago de 20000 agota Multas por completo; el segundo pago de
    // 80000 debe ir TODO a Administración, no volver a repartir Multas.
    const conceptoMultas = new Types.ObjectId();
    const conceptoAdministracion = new Types.ObjectId();
    const factura = {
      _id: new Types.ObjectId(),
      inmuebleId,
      total: 100000,
      lines: [
        { conceptoId: conceptoAdministracion, totalAmount: 80000 },
        { conceptoId: conceptoMultas, totalAmount: 20000 },
      ],
    };

    const llamadas1: Array<[Record<string, unknown>, unknown]> = [];
    const saldos1 = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadas1.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };
    const partes1 = await ajustarSaldosCartera(
      saldos1 as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      { ...factura, outstandingBalance: 80000 }, // 100000 → 80000
      20000,
      -1,
    );
    expect(partes1).toEqual([{ conceptoId: conceptoMultas, parte: 20000 }]);

    const llamadas2: Array<[Record<string, unknown>, unknown]> = [];
    const saldos2 = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadas2.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };
    const partes2 = await ajustarSaldosCartera(
      saldos2 as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      { ...factura, outstandingBalance: 0 }, // 80000 → 0
      80000,
      -1,
    );
    expect(partes2).toEqual([
      { conceptoId: conceptoAdministracion, parte: 80000 },
    ]);
  });

  it('con signo +1, restaura (nunca descuenta) — el reverso de una anulación', async () => {
    const llamadas: unknown[][] = [];
    const saldos = {
      findOneAndUpdate: jest.fn((filtro: unknown, pipeline: unknown) => {
        llamadas.push([filtro, pipeline]);
        return { exec: () => Promise.resolve(null) };
      }),
    };

    await ajustarSaldosCartera(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      {
        _id: new Types.ObjectId(),
        inmuebleId,
        total: 100000,
        outstandingBalance: 100000, // restaurado por completo: 0 → 100000
        lines: [{ conceptoId: conceptoA, totalAmount: 100000 }],
      },
      100000,
      1,
    );

    const pipeline = llamadas[0][1] as [
      { $set: { balance: { $max: [number, { $add: [string, number] }] } } },
    ];
    expect(pipeline[0].$set.balance.$max[1].$add[1]).toBe(100000);
  });

  it('no hace nada si la factura no tiene líneas o el monto es cero', async () => {
    const saldos = { findOneAndUpdate: jest.fn() };

    await ajustarSaldosCartera(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      {
        _id: new Types.ObjectId(),
        inmuebleId,
        total: 0,
        outstandingBalance: 0,
        lines: [],
      },
      0,
      -1,
    );

    expect(saldos.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('ajustarSaldosCarteraPorDistribucion', () => {
  const inmuebleId = new Types.ObjectId();
  const conceptoA = new Types.ObjectId();
  const conceptoB = new Types.ObjectId();

  it('aplicación completa: descuenta cada concepto por exactamente su propia línea de distribución, no por un split proporcional de factura', async () => {
    const llamadas: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (
          filtro: Record<string, unknown>,
          pipeline: unknown,
          _opciones?: unknown,
        ) => {
          llamadas.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };

    // Nótese: la distribución NO es proporcional a ninguna línea de factura
    // (60/40 aquí) — si esta función delegara en el split de
    // `ajustarSaldosCartera` daría otro resultado. Debe respetar EXACTAMENTE
    // los montos que el usuario eligió.
    await ajustarSaldosCarteraPorDistribucion(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      inmuebleId,
      [
        { conceptoId: conceptoA, monto: 60000 },
        { conceptoId: conceptoB, monto: 40000 },
      ],
      100000,
      -1,
    );

    expect(llamadas).toHaveLength(2);
    expect(llamadas[0][0]).toMatchObject({ inmuebleId, conceptoId: conceptoA });
    expect(llamadas[0][1]).toEqual([
      {
        $set: {
          coPropertyId: { $ifNull: ['$coPropertyId', COP] },
          inmuebleId: { $ifNull: ['$inmuebleId', inmuebleId] },
          conceptoId: { $ifNull: ['$conceptoId', conceptoA] },
          balance: {
            $max: [0, { $add: [{ $ifNull: ['$balance', 0] }, -60000] }],
          },
        },
      },
    ]);
    expect(llamadas[1][0]).toMatchObject({ inmuebleId, conceptoId: conceptoB });
    expect(llamadas[1][1]).toEqual([
      {
        $set: {
          coPropertyId: { $ifNull: ['$coPropertyId', COP] },
          inmuebleId: { $ifNull: ['$inmuebleId', inmuebleId] },
          conceptoId: { $ifNull: ['$conceptoId', conceptoB] },
          balance: {
            $max: [0, { $add: [{ $ifNull: ['$balance', 0] }, -40000] }],
          },
        },
      },
    ]);
    const [, , opciones] = saldos.findOneAndUpdate.mock.calls[0];
    expect(opciones).toMatchObject({
      session: SESSION,
      updatePipeline: true,
      upsert: true,
    });
  });

  it('devuelve el mismo desglose por concepto que aplicó — para que el asiento use la misma cuenta', async () => {
    const saldos = {
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };

    const partes = await ajustarSaldosCarteraPorDistribucion(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      inmuebleId,
      [
        { conceptoId: conceptoA, monto: 60000 },
        { conceptoId: conceptoB, monto: 40000 },
      ],
      100000,
      -1,
    );

    expect(partes).toEqual([
      { conceptoId: conceptoA, parte: 60000 },
      { conceptoId: conceptoB, parte: 40000 },
    ]);
  });

  it('aplicación parcial (anticipo): escala cada línea proporcionalmente, y la última absorbe el resto del redondeo para cerrar exacto en montoAplicado', async () => {
    const llamadas: unknown[][] = [];
    const saldos = {
      findOneAndUpdate: jest.fn((filtro: unknown, pipeline: unknown) => {
        llamadas.push([filtro, pipeline]);
        return { exec: () => Promise.resolve(null) };
      }),
    };
    const conceptoC = new Types.ObjectId();

    // Distribución total: 300000. Solo se aplican 10000 ahora (la factura
    // ancla no tenía saldo suficiente) — igual que el test de redondeo de
    // `ajustarSaldosCartera` de arriba, mismos números, mismo assert style.
    await ajustarSaldosCarteraPorDistribucion(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      inmuebleId,
      [
        { conceptoId: conceptoA, monto: 100000 },
        { conceptoId: conceptoB, monto: 100000 },
        { conceptoId: conceptoC, monto: 100000 },
      ],
      10000,
      -1,
    );

    const montos = llamadas.map(
      ([, pipeline]) =>
        -(
          pipeline as [
            {
              $set: { balance: { $max: [number, { $add: [string, number] }] } };
            },
          ]
        )[0].$set.balance.$max[1].$add[1],
    );
    expect(montos.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('con signo +1, restaura (nunca descuenta) — el reverso de una anulación', async () => {
    const llamadas: unknown[][] = [];
    const saldos = {
      findOneAndUpdate: jest.fn((filtro: unknown, pipeline: unknown) => {
        llamadas.push([filtro, pipeline]);
        return { exec: () => Promise.resolve(null) };
      }),
    };

    await ajustarSaldosCarteraPorDistribucion(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      inmuebleId,
      [{ conceptoId: conceptoA, monto: 60000 }],
      60000,
      1,
    );

    const pipeline = llamadas[0][1] as [
      { $set: { balance: { $max: [number, { $add: [string, number] }] } } },
    ];
    expect(pipeline[0].$set.balance.$max[1].$add[1]).toBe(60000);
  });

  it('no hace nada si la distribución está vacía o el monto es cero', async () => {
    const saldos = { findOneAndUpdate: jest.fn() };

    await ajustarSaldosCarteraPorDistribucion(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      inmuebleId,
      [],
      0,
      -1,
    );
    await ajustarSaldosCarteraPorDistribucion(
      saldos as never,
      carteraPorDocumentoMock() as never,
      SESSION,
      COP,
      inmuebleId,
      [{ conceptoId: conceptoA, monto: 60000 }],
      0,
      -1,
    );

    expect(saldos.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('decrementarSaldoNotaDebito', () => {
  const notaDebitoId = new Types.ObjectId();
  const notaDebitoDoc = { _id: notaDebitoId, total: 50000 };
  const notasDebitoCon = (doc: unknown = notaDebitoDoc) => ({
    findOne: jest.fn(() => ({
      session: () => ({ exec: () => Promise.resolve(doc) }),
    })),
  });

  it('descuenta el monto cuando el saldo alcanza', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(50000);
    const notasDebito = notasDebitoCon();

    const resultado = await decrementarSaldoNotaDebito(
      notasDebito as never,
      saldoTotalDocumento as never,
      SESSION,
      COP,
      notaDebitoId,
      20000,
    );

    expect(resultado.outstandingBalance).toBe(30000);
  });

  it('rechaza cuando el monto excede el saldo pendiente', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(50000);
    const notasDebito = notasDebitoCon();

    await expect(
      decrementarSaldoNotaDebito(
        notasDebito as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        notaDebitoId,
        999999,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza un monto negativo sin tocar la base de datos', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(50000);
    const notasDebito = notasDebitoCon();

    await expect(
      decrementarSaldoNotaDebito(
        notasDebito as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        notaDebitoId,
        -50,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(saldoTotalDocumento.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rechaza un monto cero sin tocar la base de datos', async () => {
    const { mock: saldoTotalDocumento } = saldoTotalDocumentoCon(50000);
    const notasDebito = notasDebitoCon();

    await expect(
      decrementarSaldoNotaDebito(
        notasDebito as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        notaDebitoId,
        0,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(saldoTotalDocumento.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('concurrencia: dos aplicaciones simultáneas contra la misma nota débito nunca la descuentan doble', async () => {
    const { mock: saldoTotalDocumento, saldoActual } =
      saldoTotalDocumentoCon(30000);
    const notasDebito = notasDebitoCon();

    const resultados = await Promise.allSettled([
      decrementarSaldoNotaDebito(
        notasDebito as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        notaDebitoId,
        20000,
      ),
      decrementarSaldoNotaDebito(
        notasDebito as never,
        saldoTotalDocumento as never,
        SESSION,
        COP,
        notaDebitoId,
        20000,
      ),
    ]);

    const cumplidas = resultados.filter((r) => r.status === 'fulfilled');
    expect(cumplidas).toHaveLength(1);
    expect(saldoActual()).toBe(10000);
  });
});

describe('evaluarAplicacionConDescuento', () => {
  const deadline = new Date('2026-08-10');
  const facturaConDescuento = (over: Record<string, unknown> = {}) => ({
    outstandingBalance: 400000,
    discountAmount: 40000,
    discountDeadline: deadline,
    ...over,
  });

  it('activa el descuento cuando el dinero disponible más el descuento saldan la factura exacto', () => {
    const resultado = evaluarAplicacionConDescuento(
      facturaConDescuento(),
      new Date('2026-08-05'),
      360000,
    );
    expect(resultado).toEqual({ montoAFactura: 400000, montoDescuento: 40000 });
  });

  it('activa el descuento cuando el dinero disponible sobra respecto a lo que hace falta', () => {
    const resultado = evaluarAplicacionConDescuento(
      facturaConDescuento(),
      new Date('2026-08-05'),
      500000,
    );
    expect(resultado).toEqual({ montoAFactura: 400000, montoDescuento: 40000 });
  });

  it('no activa el descuento cuando ni con él alcanza a saldar la factura (abono parcial normal)', () => {
    const resultado = evaluarAplicacionConDescuento(
      facturaConDescuento(),
      new Date('2026-08-05'),
      300000,
    );
    expect(resultado).toEqual({ montoAFactura: 300000, montoDescuento: 0 });
  });

  it('no activa el descuento cuando la fecha del recibo ya pasó la fecha límite, aunque el dinero alcance', () => {
    const resultado = evaluarAplicacionConDescuento(
      facturaConDescuento(),
      new Date('2026-08-11'),
      360000,
    );
    expect(resultado).toEqual({ montoAFactura: 360000, montoDescuento: 0 });
  });

  it('no ofrece descuento cuando la factura no tiene uno configurado', () => {
    const resultado = evaluarAplicacionConDescuento(
      facturaConDescuento({ discountAmount: 0, discountDeadline: null }),
      new Date('2026-08-05'),
      360000,
    );
    expect(resultado).toEqual({ montoAFactura: 360000, montoDescuento: 0 });
  });

  it('capa el descuento al saldo de la factura cuando el configurado es mayor (Parámetros mal configurado)', () => {
    const resultado = evaluarAplicacionConDescuento(
      facturaConDescuento({
        outstandingBalance: 100000,
        discountAmount: 999999,
      }),
      new Date('2026-08-05'),
      0,
    );
    // El descuento nunca puede exceder el propio saldo — la caja nunca queda
    // "recibiendo" un monto negativo.
    expect(resultado).toEqual({
      montoAFactura: 100000,
      montoDescuento: 100000,
    });
  });

  it('no capa el monto cuando el descuento no se activa — deja que decrementarSaldoFactura rechace si excede (modo manual)', () => {
    const resultado = evaluarAplicacionConDescuento(
      facturaConDescuento({
        outstandingBalance: 100000,
        discountAmount: 0,
        discountDeadline: null,
      }),
      new Date('2026-08-05'),
      200000,
    );
    expect(resultado).toEqual({ montoAFactura: 200000, montoDescuento: 0 });
  });
});

describe('remanentesPorLinea', () => {
  const conceptoAdmin = new Types.ObjectId();
  const conceptoIntereses = new Types.ObjectId();

  it('sin ningún remainingAmount rastreado (factura nunca tocada por un reparto elegido), lo deriva de la cascada — mismo orden que ajustarSaldosCartera', () => {
    // Factura de 500000 (Admin 300000 + Intereses 200000, Intereses de
    // último en el arreglo → primero en la cascada); 150000 ya aplicados.
    const remanentes = remanentesPorLinea({
      total: 500000,
      outstandingBalance: 350000,
      lines: [
        { conceptoId: conceptoAdmin, totalAmount: 300000 },
        { conceptoId: conceptoIntereses, totalAmount: 200000 },
      ],
    });

    expect(remanentes.get(conceptoIntereses.toString())).toBe(50000);
    expect(remanentes.get(conceptoAdmin.toString())).toBe(300000);
  });

  it('con remainingAmount ya rastreado en una línea, lo reporta tal cual — sin importar el estado de las demás', () => {
    const remanentes = remanentesPorLinea({
      total: 500000,
      outstandingBalance: 350000,
      lines: [
        { conceptoId: conceptoAdmin, totalAmount: 300000 }, // sin rastrear
        {
          conceptoId: conceptoIntereses,
          totalAmount: 200000,
          remainingAmount: 50000, // ya rastreado por un reparto anterior
        },
      ],
    });

    expect(remanentes.get(conceptoIntereses.toString())).toBe(50000);
    // La línea sin rastrear sigue derivándose de la cascada, sin verse
    // afectada por que la otra ya esté migrada.
    expect(remanentes.get(conceptoAdmin.toString())).toBe(300000);
  });
});

describe('validarDistribucionManual', () => {
  const concepto = new Types.ObjectId().toString();

  it('acepta un reparto que suma exacto y no supera el remanente', () => {
    expect(() =>
      validarDistribucionManual(
        [{ conceptoId: concepto, monto: 100000 }],
        100000,
        new Map([[concepto, 150000]]),
      ),
    ).not.toThrow();
  });

  it('rechaza cuando la suma no coincide con el monto a aplicar', () => {
    expect(() =>
      validarDistribucionManual(
        [{ conceptoId: concepto, monto: 90000 }],
        100000,
        new Map([[concepto, 150000]]),
      ),
    ).toThrow(ConflictException);
  });

  it('rechaza cuando un concepto pide más de lo que le queda pendiente', () => {
    expect(() =>
      validarDistribucionManual(
        [{ conceptoId: concepto, monto: 100000 }],
        100000,
        new Map([[concepto, 50000]]),
      ),
    ).toThrow(ConflictException);
  });
});

import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ajustarSaldosCartera, decrementarSaldoFactura } from './cruce.util';

const SESSION = { id: 'fake-session' } as never;
const COP = new Types.ObjectId();

describe('decrementarSaldoFactura', () => {
  const facturaId = new Types.ObjectId();

  it('descuenta el monto cuando el saldo alcanza', async () => {
    const facturas = {
      findOneAndUpdate: jest.fn((_filtro: Record<string, unknown>) => ({
        exec: () => {
          const alcanza = 500000 >= 200000;
          if (!alcanza) return Promise.resolve(null);
          return Promise.resolve({
            _id: facturaId,
            outstandingBalance: 300000,
            inmuebleId: new Types.ObjectId(),
            total: 500000,
            lines: [],
          });
        },
      })),
    };

    const resultado = await decrementarSaldoFactura(
      facturas as never,
      SESSION,
      COP,
      facturaId,
      200000,
    );

    expect(resultado.outstandingBalance).toBe(300000);
  });

  it('rechaza cuando el monto excede el saldo pendiente — la guarda $expr', async () => {
    const facturas = {
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };

    await expect(
      decrementarSaldoFactura(
        facturas as never,
        SESSION,
        COP,
        facturaId,
        999999,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('la condición de descuento es una sola operación atómica ($expr + $inc en el mismo findOneAndUpdate)', async () => {
    const facturas = {
      findOneAndUpdate: jest.fn(
        (_filtro: Record<string, unknown>, _actualizacion?: unknown) => ({
          exec: () =>
            Promise.resolve({ _id: facturaId, outstandingBalance: 100 }),
        }),
      ),
    };

    await decrementarSaldoFactura(
      facturas as never,
      SESSION,
      COP,
      facturaId,
      50,
    );

    expect(facturas.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro, actualizacion] = facturas.findOneAndUpdate.mock.calls[0];
    expect(filtro).toMatchObject({
      _id: facturaId,
      coPropertyId: COP,
      status: 'emitida',
      $expr: { $gte: ['$outstandingBalance', 50] },
    });
    expect(actualizacion).toEqual({ $inc: { outstandingBalance: -50 } });
  });

  it('concurrencia: dos aplicaciones simultáneas contra la misma factura nunca la descuentan doble', async () => {
    // Simula el estado real de Mongo: cada findOneAndUpdate ve el resultado
    // de la anterior, igual que "avanza uno y nunca repite" en
    // numeracion.service.spec.ts — JS es de un solo hilo, así que
    // Promise.all no paraleliza de verdad, pero SÍ ejercita el orden en que
    // dos llamadas concurrentes entrelazarían sus `await` reales.
    let saldo = 300000;
    const facturas = {
      findOneAndUpdate: jest.fn((filtro: Record<string, unknown>) => ({
        exec: () => {
          const expr = filtro.$expr as { $gte: [string, number] };
          const monto = expr.$gte[1];
          if (saldo < monto) return Promise.resolve(null);
          saldo -= monto;
          return Promise.resolve({ _id: facturaId, outstandingBalance: saldo });
        },
      })),
    };

    const resultados = await Promise.allSettled([
      decrementarSaldoFactura(
        facturas as never,
        SESSION,
        COP,
        facturaId,
        200000,
      ),
      decrementarSaldoFactura(
        facturas as never,
        SESSION,
        COP,
        facturaId,
        200000,
      ),
    ]);

    const cumplidas = resultados.filter((r) => r.status === 'fulfilled');
    expect(cumplidas).toHaveLength(1);
    expect(saldo).toBe(100000);
  });
});

describe('ajustarSaldosCartera', () => {
  const inmuebleId = new Types.ObjectId();
  const conceptoA = new Types.ObjectId();
  const conceptoB = new Types.ObjectId();

  it('reparte el monto proporcionalmente entre las líneas de la factura', async () => {
    const llamadas: Array<[Record<string, unknown>, unknown]> = [];
    const saldos = {
      findOneAndUpdate: jest.fn(
        (filtro: Record<string, unknown>, pipeline: unknown) => {
          llamadas.push([filtro, pipeline]);
          return { exec: () => Promise.resolve(null) };
        },
      ),
    };

    await ajustarSaldosCartera(
      saldos as never,
      SESSION,
      COP,
      {
        inmuebleId,
        total: 500000,
        lines: [
          { conceptoId: conceptoA, totalAmount: 400000 },
          { conceptoId: conceptoB, totalAmount: 100000 },
        ],
      },
      100000,
      -1,
    );

    expect(llamadas).toHaveLength(2);
    expect(llamadas[0][0]).toMatchObject({ conceptoId: conceptoA });
    expect(llamadas[1][0]).toMatchObject({ conceptoId: conceptoB });
    // 80% a conceptoA (80000), 20% a conceptoB (20000) — 100000 en total.
    expect(llamadas[0][1]).toEqual([
      { $set: { balance: { $max: [0, { $add: ['$balance', -80000] }] } } },
    ]);
    expect(llamadas[1][1]).toEqual([
      { $set: { balance: { $max: [0, { $add: ['$balance', -20000] }] } } },
    ]);
  });

  it('la última línea absorbe el resto del redondeo, para que la suma cierre exacto', async () => {
    const llamadas: unknown[][] = [];
    const saldos = {
      findOneAndUpdate: jest.fn((filtro: unknown, pipeline: unknown) => {
        llamadas.push([filtro, pipeline]);
        return { exec: () => Promise.resolve(null) };
      }),
    };

    await ajustarSaldosCartera(
      saldos as never,
      SESSION,
      COP,
      {
        inmuebleId,
        total: 300000,
        lines: [
          { conceptoId: conceptoA, totalAmount: 100000 },
          { conceptoId: conceptoB, totalAmount: 100000 },
          { conceptoId: new Types.ObjectId(), totalAmount: 100000 },
        ],
      },
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

    await ajustarSaldosCartera(
      saldos as never,
      SESSION,
      COP,
      {
        inmuebleId,
        total: 100000,
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
      SESSION,
      COP,
      { inmuebleId, total: 0, lines: [] },
      0,
      -1,
    );

    expect(saldos.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

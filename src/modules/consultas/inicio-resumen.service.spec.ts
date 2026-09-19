import { Types } from 'mongoose';
import { InicioResumenService } from './inicio-resumen.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const find = (data: unknown[] = []) => ({
  find: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue(data),
});

/** The `facturas` model needs BOTH `findOne(...).sort(...).exec()` (period
 *  resolution) and `find(...).exec()` (Facturas sharing that period) on the
 *  SAME mocked instance — each call builds and returns its own independent
 *  chain object, exactly like the real Mongoose query builder, so the two
 *  queries never share (and clobber) one `exec` mock. */
const facturasModel = (
  ultimaFactura: unknown,
  facturasDelPeriodo: unknown[] = [],
) => ({
  findOne: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(ultimaFactura),
    }),
  }),
  find: jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue(facturasDelPeriodo),
  }),
});

const servicio = (overrides: Record<string, unknown> = {}) => {
  const defaults: Record<string, unknown> = {
    facturas: facturasModel(null),
    recibos: find(),
    aplicaciones: find(),
    tenant: { resolveCoPropertyId: () => COP },
  };
  const m = { ...defaults, ...overrides };

  return new InicioResumenService(
    m.facturas as never,
    m.recibos as never,
    m.aplicaciones as never,
    m.tenant as never,
  );
};

describe('InicioResumenService', () => {
  describe('resolución de periodo', () => {
    it('retorna el estado vacío cuando la copropiedad no tiene ninguna Factura', async () => {
      const svc = servicio();

      const result = await svc.findResumen();

      expect(result).toEqual({
        periodo: null,
        totalFacturado: 0,
        facturadoPorConcepto: [],
        totalIngresosRecibidos: 0,
        recibidoPorConcepto: [],
      });
    });

    it('usa el periodStart/periodEnd de la Factura emitida más reciente', async () => {
      const periodStart = new Date('2026-08-01');
      const periodEnd = new Date('2026-08-31');
      const ultimaFactura = {
        _id: id(),
        coPropertyId: COP,
        periodStart,
        periodEnd,
      };

      const svc = servicio({
        facturas: facturasModel(ultimaFactura, [
          {
            _id: id(),
            coPropertyId: COP,
            status: 'emitida',
            periodStart,
            periodEnd,
            total: 0,
            lines: [],
          },
        ]),
      });

      const result = await svc.findResumen();

      expect(result.periodo).toEqual({
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      });
    });
  });

  describe('Total Facturado', () => {
    it('suma total y agrupa facturadoPorConcepto por conceptoId', async () => {
      const periodStart = new Date('2026-08-01');
      const periodEnd = new Date('2026-08-31');
      const conceptoAdmin = id();
      const conceptoMora = id();

      const facturas = [
        {
          _id: id(),
          coPropertyId: COP,
          status: 'emitida',
          periodStart,
          periodEnd,
          total: 150000,
          lines: [
            {
              conceptoId: conceptoAdmin,
              conceptName: 'Administración',
              totalAmount: 100000,
            },
            {
              conceptoId: conceptoMora,
              conceptName: 'Intereses de Mora',
              totalAmount: 50000,
            },
          ],
        },
        {
          _id: id(),
          coPropertyId: COP,
          status: 'emitida',
          periodStart,
          periodEnd,
          total: 100000,
          lines: [
            {
              conceptoId: conceptoAdmin,
              conceptName: 'Administración',
              totalAmount: 100000,
            },
          ],
        },
      ];

      const svc = servicio({
        facturas: facturasModel(facturas[0], facturas),
      });

      const result = await svc.findResumen();

      expect(result.totalFacturado).toBe(250000);
      expect(result.facturadoPorConcepto).toEqual(
        expect.arrayContaining([
          {
            conceptoId: conceptoAdmin.toString(),
            nombre: 'Administración',
            monto: 200000,
          },
          {
            conceptoId: conceptoMora.toString(),
            nombre: 'Intereses de Mora',
            monto: 50000,
          },
        ]),
      );
    });
  });

  describe('Total Ingresos Recibidos', () => {
    it('suma receivedAmount de Recibos activos del periodo', async () => {
      const periodStart = new Date('2026-08-01');
      const periodEnd = new Date('2026-08-31');
      const ultimaFactura = {
        _id: id(),
        coPropertyId: COP,
        periodStart,
        periodEnd,
      };

      const recibos = [
        {
          _id: id(),
          coPropertyId: COP,
          status: 'activo',
          receivedDate: new Date('2026-08-15'),
          receivedAmount: 300000,
        },
        {
          _id: id(),
          coPropertyId: COP,
          status: 'activo',
          receivedDate: new Date('2026-08-20'),
          receivedAmount: 200000,
        },
      ];

      const svc = servicio({
        facturas: facturasModel(ultimaFactura, []),
        recibos: find(recibos),
        aplicaciones: find([]),
      });

      const result = await svc.findResumen();

      expect(result.totalIngresosRecibidos).toBe(500000);
      // Sin aplicaciones, todo el ingreso cae en el slice "Anticipos".
      expect(result.recibidoPorConcepto).toEqual([
        { conceptoId: 'anticipos', nombre: 'Anticipos', monto: 500000 },
      ]);
    });
  });

  describe('escalado por descuento (Recibido por Concepto)', () => {
    it('reproduce el ejemplo del spec: Recibo $1.000.000, $909.800 en efectivo + $52.200 de descuento → Anticipos = $90.200', async () => {
      const periodStart = new Date('2026-08-01');
      const periodEnd = new Date('2026-08-31');
      const ultimaFactura = {
        _id: id(),
        coPropertyId: COP,
        periodStart,
        periodEnd,
      };

      const reciboId = id();
      const recibos = [
        {
          _id: reciboId,
          coPropertyId: COP,
          status: 'activo',
          receivedDate: new Date('2026-08-10'),
          receivedAmount: 1_000_000,
        },
      ];

      const conceptoAdmin = id();
      // amountApplied = 962.000 (909.800 cash + 52.200 discount); the
      // remaining 38.000 of the 1.000.000 gross was never applied at all.
      const aplicaciones = [
        {
          _id: id(),
          coPropertyId: COP,
          sourceType: 'RC',
          sourceId: reciboId,
          status: 'activa',
          amountApplied: 962_000,
          discountApplied: 52_200,
          detalleConceptos: [
            {
              conceptoId: conceptoAdmin,
              conceptName: 'Administración',
              monto: 962_000,
            },
          ],
        },
      ];

      const svc = servicio({
        facturas: facturasModel(ultimaFactura, []),
        recibos: find(recibos),
        aplicaciones: find(aplicaciones),
      });

      const result = await svc.findResumen();

      expect(result.totalIngresosRecibidos).toBe(1_000_000);
      const administracion = result.recibidoPorConcepto.find(
        (c) => c.conceptoId === conceptoAdmin.toString(),
      );
      expect(administracion?.monto).toBeCloseTo(909_800);

      const anticipos = result.recibidoPorConcepto.find(
        (c) => c.conceptoId === 'anticipos',
      );
      expect(anticipos?.monto).toBeCloseTo(90_200);
    });

    it('no incluye el slice Anticipos cuando no queda efectivo sin aplicar', async () => {
      const periodStart = new Date('2026-08-01');
      const periodEnd = new Date('2026-08-31');
      const ultimaFactura = {
        _id: id(),
        coPropertyId: COP,
        periodStart,
        periodEnd,
      };

      const reciboId = id();
      const recibos = [
        {
          _id: reciboId,
          coPropertyId: COP,
          status: 'activo',
          receivedDate: new Date('2026-08-10'),
          receivedAmount: 100000,
        },
      ];

      const conceptoAdmin = id();
      const aplicaciones = [
        {
          _id: id(),
          coPropertyId: COP,
          sourceType: 'RC',
          sourceId: reciboId,
          status: 'activa',
          amountApplied: 100000,
          discountApplied: 0,
          detalleConceptos: [
            {
              conceptoId: conceptoAdmin,
              conceptName: 'Administración',
              monto: 100000,
            },
          ],
        },
      ];

      const svc = servicio({
        facturas: facturasModel(ultimaFactura, []),
        recibos: find(recibos),
        aplicaciones: find(aplicaciones),
      });

      const result = await svc.findResumen();

      expect(
        result.recibidoPorConcepto.some((c) => c.conceptoId === 'anticipos'),
      ).toBe(false);
    });
  });
});

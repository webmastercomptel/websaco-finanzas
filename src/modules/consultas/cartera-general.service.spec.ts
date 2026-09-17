import { Types } from 'mongoose';
import { CarteraGeneralService } from './cartera-general.service';

const COP = new Types.ObjectId();
const id = () => new Types.ObjectId();

const servicio = (overrides: Record<string, unknown> = {}) => {
  const find = (data: unknown[] = []) => ({
    find: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(data),
  });
  const defaults: Record<string, unknown> = {
    facturas: find(),
    notasDebito: find(),
    aplicaciones: find(),
    saldosCartera: find(),
    conceptosCobro: find(),
    tenant: { resolveCoPropertyId: () => COP },
    saldosIniciales: find(),
  };
  const m = { ...defaults, ...overrides };
  return new CarteraGeneralService(
    m.facturas as never,
    m.notasDebito as never,
    m.aplicaciones as never,
    m.saldosCartera as never,
    m.conceptosCobro as never,
    m.tenant as never,
    m.saldosIniciales as never,
  );
};

describe('CarteraGeneralService', () => {
  describe('totales', () => {
    it('totalCartera, totalVencido, totalPendiente y porcentajeVencido suman correctamente', async () => {
      const inmVencido = id();
      const inmPendiente = id();

      // Factura vencida (dueDate before fecha)
      const f1 = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmVencido,
        issueDate: new Date('2026-01-01'),
        dueDate: new Date('2026-06-01'),
        total: 300000,
        outstandingBalance: 300000,
        status: 'emitida',
      };
      // Factura pendiente (dueDate after fecha)
      const f2 = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmPendiente,
        issueDate: new Date('2026-07-01'),
        dueDate: new Date('2099-01-01'),
        total: 100000,
        outstandingBalance: 100000,
        status: 'emitida',
      };

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f1, f2]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({});

      expect(result.totalCartera).toBe(400000);
      expect(result.totalVencido).toBe(300000);
      expect(result.totalPendiente).toBe(100000);
      expect(result.porcentajeVencido).toBeCloseTo(75);
    });
  });

  describe('diasPromedioMora', () => {
    it('es el promedio correcto entre inmuebles vencidos', async () => {
      const inm1 = id();
      const inm2 = id();

      const f1 = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inm1,
        issueDate: new Date('2026-01-01'),
        dueDate: new Date('2026-06-01'),
        total: 100000,
        outstandingBalance: 100000,
        status: 'emitida',
      };
      // inm2: dueDate = Jun 15 → 16 days before Jul 1
      const f2 = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inm2,
        issueDate: new Date('2026-01-01'),
        dueDate: new Date('2026-06-15'),
        total: 100000,
        outstandingBalance: 100000,
        status: 'emitida',
      };

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f1, f2]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({ fecha: '2026-07-01' });

      // inm1: Jul 1 - Jun 1 = 30 days; inm2: Jul 1 - Jun 15 = 16 days
      // average = (30 + 16) / 2 = 23
      expect(result.diasPromedioMora).toBe(23);
    });
  });

  describe('totalCarteraMesAnterior', () => {
    it('usa una fecha genuinamente distinta a totalCartera', async () => {
      // A Factura issued two months ago, paid off THIS month via an
      // AplicacionCartera. If totalCarteraMesAnterior reused `fecha` (today)
      // instead of the last day of the PREVIOUS month, it would also see
      // this application and wrongly report the same reduced balance.
      const inmId = id();
      const now = new Date();
      const dosAtras = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      const facturaId = id();

      const f = {
        _id: facturaId,
        coPropertyId: COP,
        inmuebleId: inmId,
        issueDate: dosAtras,
        dueDate: dosAtras,
        total: 500000,
        outstandingBalance: 300000,
        status: 'emitida',
      };
      const app = {
        _id: id(),
        coPropertyId: COP,
        documentType: 'FV',
        documentId: facturaId,
        amountApplied: 200000,
        status: 'activa',
        revertedAt: null,
        // Applied earlier today — guaranteed <= "now" regardless of which
        // day of the month it is, but still after the previous month ended.
        appliedAt: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      };

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([app]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({});

      // Today: the application already happened, so the balance is reduced.
      expect(result.totalCartera).toBe(300000);
      // Last month: the application hadn't happened yet — full balance.
      expect(result.totalCarteraMesAnterior).toBe(500000);
    });

    it('resuelve el ULTIMO dia del mes anterior en UTC, no en un huso local (bug real reportado)', async () => {
      // Bug real: `prevMonth.setDate(0)`/`setHours(...)` (locales) sobre una
      // fecha de corte de julio, corridos en un huso detrás de UTC (p. ej.
      // Colombia, UTC-5), calculaban MAYO en vez de JUNIO — un mes entero de
      // diferencia, no solo unas horas. Una Factura de junio (el mes
      // anterior real) debía seguir contando en `totalCarteraMesAnterior`.
      const inmId = id();
      const f = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: inmId,
        issueDate: new Date('2026-06-30T00:00:00.000Z'),
        dueDate: new Date('2026-06-30T00:00:00.000Z'),
        total: 400000,
        outstandingBalance: 400000,
        status: 'emitida',
      };

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([f]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({ fecha: '2026-07-01' });

      expect(result.totalCarteraMesAnterior).toBe(400000);
    });
  });

  describe('carteraPorConcepto', () => {
    it('suma SaldoCartera correctamente por concepto y usa nombre de ConceptoCobro', async () => {
      const conceptoId = id();
      const sc1 = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: id(),
        conceptoId,
        balance: 80000,
      };
      const sc2 = {
        _id: id(),
        coPropertyId: COP,
        inmuebleId: id(),
        conceptoId,
        balance: 20000,
      };
      const concepto = { _id: conceptoId, name: 'Administración' };

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([sc1, sc2]),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([concepto]),
        },
      });

      const result = await svc.findAll({});

      expect(result.carteraPorConcepto).toHaveLength(1);
      expect(result.carteraPorConcepto[0]).toMatchObject({
        conceptoId: conceptoId.toString(),
        nombre: 'Administración',
        saldo: 100000,
      });
    });

    it('respeta el sortOrder del catalogo de conceptos, no el orden en que llegan las filas de SaldoCartera (bug real reportado)', async () => {
      const idAdmin = id();
      const idIntereses = id();
      const idMultas = id();
      // SaldoCartera llega en un orden que NO coincide con el catalogo —
      // antes, ese orden de llegada era el que terminaba mostrando el
      // gráfico/lista de Cartera General.
      const saldos = [
        {
          _id: id(),
          coPropertyId: COP,
          inmuebleId: id(),
          conceptoId: idMultas,
          balance: 10000,
        },
        {
          _id: id(),
          coPropertyId: COP,
          inmuebleId: id(),
          conceptoId: idAdmin,
          balance: 142000000,
        },
        {
          _id: id(),
          coPropertyId: COP,
          inmuebleId: id(),
          conceptoId: idIntereses,
          balance: 5000,
        },
      ];
      // El catalogo, ya ordenado por sortOrder (como lo devuelve Mongo con
      // .sort({ sortOrder: 1 })): Administracion, Intereses, Multas.
      const conceptos = [
        { _id: idAdmin, name: 'Administracion', sortOrder: 100 },
        { _id: idIntereses, name: 'Intereses', sortOrder: 200 },
        { _id: idMultas, name: 'Multas', sortOrder: 300 },
      ];

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(saldos),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(conceptos),
        },
      });

      const result = await svc.findAll({});

      expect(result.carteraPorConcepto.map((c) => c.nombre)).toEqual([
        'Administracion',
        'Intereses',
        'Multas',
      ]);
      expect(result.carteraPorConcepto[0].saldo).toBe(142000000);
    });

    it('una fila de SaldoCartera cuyo ConceptoCobro ya no existe se muestra como Desconocido, al final, sin desaparecer del total', async () => {
      const idAdmin = id();
      const idBorrado = id();
      const saldos = [
        {
          _id: id(),
          coPropertyId: COP,
          inmuebleId: id(),
          conceptoId: idBorrado,
          balance: 30000,
        },
        {
          _id: id(),
          coPropertyId: COP,
          inmuebleId: id(),
          conceptoId: idAdmin,
          balance: 70000,
        },
      ];
      const conceptos = [
        { _id: idAdmin, name: 'Administracion', sortOrder: 100 },
      ];

      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(saldos),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue(conceptos),
        },
      });

      const result = await svc.findAll({});

      expect(result.carteraPorConcepto).toEqual([
        {
          conceptoId: idAdmin.toString(),
          nombre: 'Administracion',
          saldo: 70000,
        },
        {
          conceptoId: idBorrado.toString(),
          nombre: 'Desconocido',
          saldo: 30000,
        },
      ]);
    });
  });

  describe('tendenciaRecaudo', () => {
    it('retorna exactamente 6 entradas incluyendo meses con monto 0', async () => {
      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({});

      expect(result.tendenciaRecaudo).toHaveLength(6);
      // All monto should be 0 (no applications)
      for (const entry of result.tendenciaRecaudo) {
        expect(entry.monto).toBe(0);
      }
    });

    it('excluye aplicaciones revertidas del monto del mes', async () => {
      const now = new Date();
      const apps = [
        {
          _id: id(),
          coPropertyId: COP,
          amountApplied: 50000,
          status: 'revertida',
          appliedAt: new Date(now.getFullYear(), now.getMonth(), 10),
        },
        {
          _id: id(),
          coPropertyId: COP,
          amountApplied: 30000,
          status: 'activa',
          appliedAt: new Date(now.getFullYear(), now.getMonth(), 15),
        },
      ];

      // Mock aplicaciones.find to respect status filter
      const svc = servicio({
        facturas: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        notasDebito: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        aplicaciones: {
          find: jest
            .fn()
            .mockImplementation((filter: Record<string, unknown>) => ({
              exec: jest
                .fn()
                .mockResolvedValue(
                  apps.filter(
                    (a) => !filter.status || a.status === filter.status,
                  ),
                ),
            })),
        },
        saldosCartera: {
          find: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
        conceptosCobro: {
          find: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await svc.findAll({});

      const currentMonth = result.tendenciaRecaudo.find(
        (e) => e.anio === now.getFullYear() && e.mes === now.getMonth() + 1,
      );
      expect(currentMonth?.monto).toBe(30000);
    });
  });

  describe('sin datos', () => {
    it('retorna estructura con ceros, no error', async () => {
      const svc = servicio();

      const result = await svc.findAll({});

      expect(result.totalCartera).toBe(0);
      expect(result.totalVencido).toBe(0);
      expect(result.totalPendiente).toBe(0);
      expect(result.porcentajeVencido).toBe(0);
      expect(result.diasPromedioMora).toBe(0);
      expect(result.carteraPorConcepto).toEqual([]);
      expect(result.tendenciaRecaudo).toHaveLength(6);
    });
  });
});

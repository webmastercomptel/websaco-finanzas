import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LotesFacturacionService } from './lotes.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';

type Filtro = Record<string, unknown>;

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId().toString();

const loteDoc = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'lote-1' },
  coPropertyId: COP,
  number: 1,
  status: 'borrador',
  billingDate: new Date('2026-08-27'),
  dueDate: new Date('2026-08-31'),
  periodStart: new Date('2026-08-01'),
  periodEnd: new Date('2026-08-31'),
  earlyPaymentDiscount: 0,
  discountGraceDays: 0,
  lateInterestRate: 0,
  lateInterestCap: null,
  adjustments: [],
  preview: [],
  invoiceIds: [],
  summary: null,
  generatedBy: { toString: () => CUENTA },
  ...over,
});

const lotesModeloCon = (opts: { activo?: Record<string, unknown> } = {}) => {
  const escrituras: Record<string, unknown>[] = [];
  return {
    escrituras,
    exists: jest.fn(() => ({
      exec: () => Promise.resolve(opts.activo ? { _id: 'x' } : null),
    })),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve(loteDoc(doc));
    }),
  };
};

const numeracionCon = (numero = 1): NumeracionService =>
  ({
    siguienteLote: jest.fn().mockResolvedValue(numero),
  }) as unknown as NumeracionService;

const tenantQueDevuelve = (id: Types.ObjectId | null): TenantContextService =>
  ({
    resolveCoPropertyId: () => {
      if (id === null) throw new ForbiddenException('sin copropiedad activa');
      return id;
    },
  }) as unknown as TenantContextService;

describe('LotesFacturacionService.crear', () => {
  it('rechaza crear un lote nuevo si ya hay uno borrador o liquidado', async () => {
    const lotes = lotesModeloCon({ activo: {} });
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    await expect(
      service.crear(CUENTA, {
        fechaFacturacion: '2026-08-27',
        fechaVencimiento: '2026-08-31',
        periodoDesde: '2026-08-01',
        periodoHasta: '2026-08-31',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(lotes.create).not.toHaveBeenCalled();
  });

  it('pide el número al servicio de numeración y lo guarda con los parámetros', async () => {
    const lotes = lotesModeloCon();
    const numeracion = numeracionCon(7);
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      {} as never, // conceptos
      {} as never, // valoresRecurrentes
      {} as never, // inmuebles
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracion,
    );

    await service.crear(CUENTA, {
      fechaFacturacion: '2026-08-27',
      fechaVencimiento: '2026-08-31',
      periodoDesde: '2026-08-01',
      periodoHasta: '2026-08-31',
      interesMora: 1.9,
    });

    expect(lotes.escrituras[0]).toMatchObject({
      coPropertyId: COP,
      number: 7,
      status: 'borrador',
      lateInterestRate: 1.9,
      generatedBy: CUENTA,
    });
  });
});

describe('LotesFacturacionService.cargarNovedades', () => {
  const unidadCon = (id: string, codigo: string) => ({
    _id: { toString: () => id },
    code: codigo,
  });
  const conceptoCon = (id: string, nombre: string) => ({
    _id: { toString: () => id },
    name: nombre,
  });

  it('resuelve inmueble por código y concepto por nombre, y reemplaza las novedades anteriores', async () => {
    const lotes = {
      findById: jest.fn(() => ({
        exec: () =>
          Promise.resolve(loteDoc({ adjustments: [{ vieja: true }] })),
      })),
      findByIdAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(({ code }: Filtro) => ({
        exec: () =>
          Promise.resolve(code === '301' ? unidadCon('inm-1', '301') : null),
      })),
    };
    const conceptos = {
      findOne: jest.fn(({ name }: Filtro) => ({
        exec: () =>
          Promise.resolve(
            name === 'Multas' ? conceptoCon('con-1', 'Multas') : null,
          ),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      conceptos as never,
      {} as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    const resultado = await service.cargarNovedades('lote-1', [
      { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 50000 },
    ]);

    expect(resultado).toEqual({ total: 1, cargadas: 1, errores: [] });
    const calls = lotes.findByIdAndUpdate.mock.calls as unknown[][];
    const [, actualizacion] = calls[0] as [string, Record<string, unknown>];
    expect(actualizacion.$set as Record<string, unknown>).toEqual({
      adjustments: [
        { inmuebleId: 'inm-1', conceptoId: 'con-1', amount: 50000, note: null },
      ],
    });
  });

  it('reporta por fila cuando el inmueble o el concepto no existen, sin abortar el resto', async () => {
    const lotes = {
      findById: jest.fn(() => ({ exec: () => Promise.resolve(loteDoc()) })),
      findByIdAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(loteDoc()),
      })),
    };
    const inmuebles = {
      findOne: jest.fn(({ code }: Filtro) => ({
        exec: () =>
          Promise.resolve(code === '301' ? unidadCon('inm-1', '301') : null),
      })),
    };
    const conceptos = {
      findOne: jest.fn(() => ({
        exec: () => Promise.resolve(conceptoCon('con-1', 'Multas')),
      })),
    };
    const service = new LotesFacturacionService(
      lotes as never,
      {} as never, // facturas
      {} as never, // saldos
      {} as never, // asientos
      conceptos as never,
      {} as never, // valoresRecurrentes
      inmuebles as never,
      {} as never, // terceros
      {} as never, // copropiedades
      tenantQueDevuelve(COP),
      {} as never, // periodo
      numeracionCon(),
    );

    const resultado = await service.cargarNovedades('lote-1', [
      { inmuebleCodigo: '999', nombreConcepto: 'Multas', monto: 50000 },
      { inmuebleCodigo: '301', nombreConcepto: 'Multas', monto: 20000 },
    ]);

    expect(resultado.cargadas).toBe(1);
    expect(resultado.errores).toEqual([
      { fila: 1, mensaje: 'No se encontró el inmueble con código "999"' },
    ]);
  });
});

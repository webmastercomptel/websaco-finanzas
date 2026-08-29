import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Types } from 'mongoose';
import { LotesFacturacionService } from './lotes.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { NumeracionService } from '../../common/numeracion/numeracion.service';

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

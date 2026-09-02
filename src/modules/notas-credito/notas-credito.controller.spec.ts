import { Types } from 'mongoose';
import { NotasCreditoController } from './notas-credito.controller';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const COP = new Types.ObjectId();

function makeController(
  notasCredito: Record<string, unknown>,
  recibos: Record<string, unknown> = {},
  copropiedades: Record<string, unknown> = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ code: 'COP-1', name: 'Copropiedad Test' }),
    })),
  },
) {
  return new NotasCreditoController(
    notasCredito as never,
    recibos as never,
    { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
    copropiedades as never,
  );
}

describe('NotasCreditoController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const notasCredito = {
      crear: jest.fn(() => Promise.resolve({ id: 'nc-1' })),
    };
    const controller = makeController(notasCredito);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      inmuebleId: new Types.ObjectId().toString(),
      facturaId: new Types.ObjectId().toString(),
      motivo: 'error_facturacion',
      montoTotal: 200000,
      distribucion: [
        { conceptoId: new Types.ObjectId().toString(), monto: 200000 },
      ],
    });

    expect(notasCredito.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('NotasCreditoController.aplicar', () => {
  it('delega en el servicio con el id de ruta y el accountId del caller', async () => {
    const notasCredito = {
      aplicar: jest.fn(() =>
        Promise.resolve({ aplicadas: [], montoSinAplicar: 0, errores: [] }),
      ),
    };
    const controller = makeController(notasCredito);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.aplicar(user, 'nc-1', { aplicacionAutomatica: true });

    expect(notasCredito.aplicar).toHaveBeenCalledWith(
      'nc-1',
      { aplicacionAutomatica: true },
      user.accountId,
    );
  });
});

describe('NotasCreditoController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const notasCredito = {
      anular: jest.fn(() => Promise.resolve({ id: 'nc-1', estado: 'anulado' })),
    };
    const controller = makeController(notasCredito);
    const dto = {
      motivo: 'otro' as const,
      detalle: 'Un detalle de más de veinte caracteres',
    };
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.anular(user, 'nc-1', dto);

    // Anular es la operación más sensible del módulo: el actor sale del
    // caller autenticado, nunca del body — misma razón que RecibosController.
    expect(notasCredito.anular).toHaveBeenCalledWith(
      'nc-1',
      dto,
      user.accountId,
    );
  });
});

describe('NotasCreditoController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const notasCredito = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(notasCredito);

    await controller.findAll({ estado: 'activo' });

    expect(notasCredito.findAll).toHaveBeenCalledWith({ estado: 'activo' });
  });

  it('findOne delega el id en el servicio', async () => {
    const notasCredito = {
      findOne: jest.fn(() => Promise.resolve({ id: 'nc-1' })),
    };
    const controller = makeController(notasCredito);

    await controller.findOne('nc-1');

    expect(notasCredito.findOne).toHaveBeenCalledWith('nc-1');
  });
});

describe('NotasCreditoController.generarPdf', () => {
  const notaFixture = () => ({
    _id: new Types.ObjectId(),
    fullNumber: 'NC-001-0001',
    createdAt: new Date('2026-08-10'),
    totalAmount: 100000,
    reason: 'error_facturacion',
    notes: null,
    appliedAmount: 100000,
    unappliedAmount: 0,
    distribution: [],
  });

  it('responde con Content-Type application/pdf y bytes reales', async () => {
    const notasCredito = {
      findOneRaw: jest.fn(() => Promise.resolve(notaFixture())),
    };
    const recibos = {
      findAplicacionesForSource: jest.fn(() => Promise.resolve([])),
    };
    const controller = makeController(notasCredito, recibos);
    const set = jest.fn();
    const send = jest.fn();

    await controller.generarPdf('nc-1', undefined, { set, send } as never);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Content-Type': 'application/pdf' }),
    );
    const bytes = (send.mock.calls[0] as [Buffer])[0];
    expect(bytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});

import { Types } from 'mongoose';
import { NotasDebitoController } from './notas-debito.controller';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const COP = new Types.ObjectId();

function makeController(
  notasDebito: Record<string, unknown>,
  copropiedades: Record<string, unknown> = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ code: 'COP-1', name: 'Copropiedad Test' }),
    })),
  },
) {
  return new NotasDebitoController(
    notasDebito as never,
    { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
    copropiedades as never,
  );
}

describe('NotasDebitoController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const notasDebito = {
      crear: jest.fn(() => Promise.resolve({ id: 'nd-1' })),
    };
    const controller = makeController(notasDebito);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      inmuebleId: new Types.ObjectId().toString(),
      conceptoId: new Types.ObjectId().toString(),
      total: 150000,
      fechaCargo: '2026-09-01',
      descripcion: 'Cargo por mora',
    });

    expect(notasDebito.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('NotasDebitoController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const notasDebito = {
      anular: jest.fn(() => Promise.resolve({ id: 'nd-1', estado: 'anulada' })),
    };
    const controller = makeController(notasDebito);
    const dto = {
      motivo: 'otro' as const,
      detalle: 'Un detalle de más de veinte caracteres para la anulación',
    };
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.anular(user, 'nd-1', dto);

    // Anular es la operación más sensible del módulo: el actor sale del
    // caller autenticado, nunca del body — misma razón que RecibosController.
    expect(notasDebito.anular).toHaveBeenCalledWith(
      'nd-1',
      dto,
      user.accountId,
    );
  });
});

describe('NotasDebitoController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const notasDebito = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(notasDebito);

    await controller.findAll({ estado: 'emitida' });

    expect(notasDebito.findAll).toHaveBeenCalledWith({ estado: 'emitida' });
  });

  it('findOne delega el id en el servicio', async () => {
    const notasDebito = {
      findOne: jest.fn(() => Promise.resolve({ id: 'nd-1' })),
    };
    const controller = makeController(notasDebito);

    await controller.findOne('nd-1');

    expect(notasDebito.findOne).toHaveBeenCalledWith('nd-1');
  });
});

describe('NotasDebitoController.generarPdf', () => {
  it('responde con Content-Type application/pdf y bytes reales', async () => {
    const notasDebito = {
      findOneRaw: jest.fn(() =>
        Promise.resolve({
          fullNumber: 'ND-001-0001',
          issueDate: new Date('2026-08-12'),
          total: 50000,
          description: null,
          outstandingBalance: 50000,
        }),
      ),
    };
    const controller = makeController(notasDebito);
    const set = jest.fn();
    const send = jest.fn();

    await controller.generarPdf('nd-1', undefined, { set, send } as never);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Content-Type': 'application/pdf' }),
    );
    const bytes = (send.mock.calls[0] as [Buffer])[0];
    expect(bytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});

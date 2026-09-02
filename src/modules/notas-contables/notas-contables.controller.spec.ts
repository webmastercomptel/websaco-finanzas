import { Types } from 'mongoose';
import { NotasContablesController } from './notas-contables.controller';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const COP = new Types.ObjectId();

function makeController(
  notasContables: Record<string, unknown>,
  copropiedades: Record<string, unknown> = {
    findById: jest.fn(() => ({
      exec: () => Promise.resolve({ code: 'COP-1', name: 'Copropiedad Test' }),
    })),
  },
) {
  return new NotasContablesController(
    notasContables as never,
    { resolveCoPropertyId: () => COP } as unknown as TenantContextService,
    copropiedades as never,
  );
}

describe('NotasContablesController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const notasContables = {
      crear: jest.fn(() => Promise.resolve({ id: 'nt-1' })),
    };
    const controller = makeController(notasContables);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      inmuebleId: new Types.ObjectId().toString(),
      conceptoOrigenId: new Types.ObjectId().toString(),
      conceptoDestinoId: new Types.ObjectId().toString(),
      monto: 100000,
      descripcion: 'Reclasificación de prueba',
    });

    expect(notasContables.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('NotasContablesController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const notasContables = {
      anular: jest.fn(() => Promise.resolve({ id: 'nt-1', estado: 'anulado' })),
    };
    const controller = makeController(notasContables);
    const dto = {
      motivo: 'otro' as const,
      detalle: 'Un detalle de más de veinte caracteres',
    };
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.anular(user, 'nt-1', dto);

    expect(notasContables.anular).toHaveBeenCalledWith(
      'nt-1',
      dto,
      user.accountId,
    );
  });
});

describe('NotasContablesController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const notasContables = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(notasContables);

    await controller.findAll({ estado: 'activo' });

    expect(notasContables.findAll).toHaveBeenCalledWith({ estado: 'activo' });
  });

  it('findOne delega el id en el servicio', async () => {
    const notasContables = {
      findOne: jest.fn(() => Promise.resolve({ id: 'nt-1' })),
    };
    const controller = makeController(notasContables);

    await controller.findOne('nt-1');

    expect(notasContables.findOne).toHaveBeenCalledWith('nt-1');
  });
});

describe('NotasContablesController.generarPdf', () => {
  it('responde con Content-Type application/pdf y bytes reales', async () => {
    const notasContables = {
      findOneRaw: jest.fn(() =>
        Promise.resolve({
          fullNumber: 'NT-001-0001',
          createdAt: new Date('2026-08-20'),
          monto: 30000,
          description: 'Reclasificación',
          conceptoOrigenId: new Types.ObjectId(),
          conceptoDestinoId: new Types.ObjectId(),
        }),
      ),
    };
    const controller = makeController(notasContables);
    const set = jest.fn();
    const send = jest.fn();

    await controller.generarPdf('nt-1', undefined, { set, send } as never);

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ 'Content-Type': 'application/pdf' }),
    );
    const bytes = (send.mock.calls[0] as [Buffer])[0];
    expect(bytes.subarray(0, 5).toString('utf-8')).toBe('%PDF-');
  });
});

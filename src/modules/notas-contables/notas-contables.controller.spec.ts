import { Types } from 'mongoose';
import { NotasContablesController } from './notas-contables.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(notasContables: Record<string, unknown>) {
  return new NotasContablesController(notasContables as never);
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
      codigo: 'NT',
      inmuebleId: new Types.ObjectId().toString(),
      fecha: '2026-08-15',
      tipoDocumento: 'FV',
      documentoId: new Types.ObjectId().toString(),
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
      fecha: '2026-08-20',
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

  it('findOne delega el id en el servicio — incluye documentDefinition, no hay ruta :id/pdf separada', async () => {
    const notasContables = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'nt-1', documentDefinition: null }),
      ),
    };
    const controller = makeController(notasContables);

    await controller.findOne('nt-1');

    expect(notasContables.findOne).toHaveBeenCalledWith('nt-1');
  });
});

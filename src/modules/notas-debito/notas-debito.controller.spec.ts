import { Types } from 'mongoose';
import { NotasDebitoController } from './notas-debito.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(notasDebito: Record<string, unknown>) {
  return new NotasDebitoController(notasDebito as never);
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
      codigo: 'ND',
      inmuebleId: new Types.ObjectId().toString(),
      conceptoId: new Types.ObjectId().toString(),
      motivo: 'otro',
      total: 150000,
      fechaCargo: '2026-09-01',
      fechaVencimiento: '2026-09-30',
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
      fecha: '2026-09-05',
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

  it('findOne delega el id en el servicio — incluye documentDefinition, no hay ruta :id/pdf separada', async () => {
    const notasDebito = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'nd-1', documentDefinition: null }),
      ),
    };
    const controller = makeController(notasDebito);

    await controller.findOne('nd-1');

    expect(notasDebito.findOne).toHaveBeenCalledWith('nd-1');
  });
});

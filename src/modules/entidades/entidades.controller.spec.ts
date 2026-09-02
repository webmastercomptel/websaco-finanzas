import { EntidadesController } from './entidades.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(entidades: Record<string, unknown>) {
  return new EntidadesController(entidades as never);
}

const USER: IRequestUser = {
  uid: 'uid-1',
  email: 'admin@comptel.com',
  accountId: 'account-real-1',
  nombre: 'Admin Real',
};

describe('EntidadesController.create', () => {
  it('pasa el accountId/nombre del caller autenticado, nunca del body', async () => {
    const entidades = {
      create: jest.fn(() => Promise.resolve({ id: 'ent-1' })),
    };
    const controller = makeController(entidades);

    await controller.create({ codigo: 'ENT-001', nombre: 'Calad' }, USER);

    expect(entidades.create).toHaveBeenCalledWith(
      { codigo: 'ENT-001', nombre: 'Calad' },
      { accountId: 'account-real-1', nombre: 'Admin Real' },
    );
  });

  it('usa el email como respaldo cuando el caller no tiene nombre', async () => {
    const entidades = {
      create: jest.fn(() => Promise.resolve({ id: 'ent-1' })),
    };
    const controller = makeController(entidades);
    const userSinNombre: IRequestUser = { ...USER, nombre: undefined };

    await controller.create(
      { codigo: 'ENT-001', nombre: 'Calad' },
      userSinNombre,
    );

    expect(entidades.create).toHaveBeenCalledWith(
      { codigo: 'ENT-001', nombre: 'Calad' },
      { accountId: 'account-real-1', nombre: userSinNombre.email },
    );
  });
});

describe('EntidadesController.update', () => {
  it('pasa el accountId/nombre del caller autenticado, nunca del body', async () => {
    const entidades = {
      update: jest.fn(() => Promise.resolve({ id: 'ent-1' })),
    };
    const controller = makeController(entidades);

    await controller.update('ent-1', { email: 'nuevo@ejemplo.com' }, USER);

    expect(entidades.update).toHaveBeenCalledWith(
      'ent-1',
      { email: 'nuevo@ejemplo.com' },
      { accountId: 'account-real-1', nombre: 'Admin Real' },
    );
  });
});

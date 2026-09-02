import { CopropiedadesController } from './copropiedades.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(copropiedades: Record<string, unknown>) {
  return new CopropiedadesController(copropiedades as never);
}

const USER: IRequestUser = {
  uid: 'uid-1',
  email: 'admin@comptel.com',
  accountId: 'account-real-1',
  nombre: 'Admin Real',
};

describe('CopropiedadesController.create', () => {
  it('pasa el accountId/nombre del caller autenticado, nunca del body', async () => {
    const copropiedades = {
      create: jest.fn(() => Promise.resolve({ id: 'cop-1' })),
    };
    const controller = makeController(copropiedades);

    await controller.create({ codigo: 'COP-001', nombre: 'Granada' }, USER);

    expect(copropiedades.create).toHaveBeenCalledWith(
      { codigo: 'COP-001', nombre: 'Granada' },
      { accountId: 'account-real-1', nombre: 'Admin Real' },
    );
  });

  it('usa el email como respaldo cuando el caller no tiene nombre', async () => {
    const copropiedades = {
      create: jest.fn(() => Promise.resolve({ id: 'cop-1' })),
    };
    const controller = makeController(copropiedades);
    const userSinNombre: IRequestUser = { ...USER, nombre: undefined };

    await controller.create(
      { codigo: 'COP-001', nombre: 'Granada' },
      userSinNombre,
    );

    expect(copropiedades.create).toHaveBeenCalledWith(
      { codigo: 'COP-001', nombre: 'Granada' },
      { accountId: 'account-real-1', nombre: userSinNombre.email },
    );
  });
});

describe('CopropiedadesController.update', () => {
  it('pasa el accountId/nombre del caller autenticado, nunca del body', async () => {
    const copropiedades = {
      update: jest.fn(() => Promise.resolve({ id: 'cop-1' })),
    };
    const controller = makeController(copropiedades);

    await controller.update('cop-1', { ciudad: 'Medellín' }, USER);

    expect(copropiedades.update).toHaveBeenCalledWith(
      'cop-1',
      { ciudad: 'Medellín' },
      { accountId: 'account-real-1', nombre: 'Admin Real' },
    );
  });
});

import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { OrganosController, PIPE_ORGANO } from './organos.controller';
import type { OrganosService } from './organos.service';

const user = { accountId: 'a1', email: 'x@y.co' } as IRequestUser;

describe('OrganosController', () => {
  const servicio = {
    listar: jest.fn().mockResolvedValue({ consejo: [], comiteConvivencia: [] }),
    candidatos: jest.fn().mockResolvedValue([]),
    agregar: jest.fn().mockResolvedValue({ id: 'i1' }),
    quitar: jest.fn().mockResolvedValue({ id: 'i1' }),
  };
  const controller = new OrganosController(
    servicio as unknown as OrganosService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('listar delega en el servicio', async () => {
    await controller.listar();
    expect(servicio.listar).toHaveBeenCalledWith();
  });

  it('candidatos pasa el texto de búsqueda', async () => {
    await controller.candidatos({ q: 'ana' });
    expect(servicio.candidatos).toHaveBeenCalledWith('ana');
  });

  it('agregar pasa órgano, tercero y usuario', async () => {
    await controller.agregar('consejo', { terceroId: 't1' }, user);
    expect(servicio.agregar).toHaveBeenCalledWith('consejo', 't1', user);
  });

  it('quitar pasa id y usuario', async () => {
    await controller.quitar('i1', user);
    expect(servicio.quitar).toHaveBeenCalledWith('i1', user);
  });

  it('un órgano desconocido es 400 antes de llegar al servicio', async () => {
    await expect(
      PIPE_ORGANO.transform('presidencia' as never, {
        type: 'param',
        data: 'organo',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      PIPE_ORGANO.transform('comite_convivencia' as never, {
        type: 'param',
        data: 'organo',
      }),
    ).resolves.toBe('comite_convivencia');
    expect(servicio.agregar).not.toHaveBeenCalled();
  });
});

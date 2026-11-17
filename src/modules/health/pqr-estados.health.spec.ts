import type { Model } from 'mongoose';
import type { Pqr } from '../../database/schemas/administracion/pqr.schema';
import { PqrEstadosHealthIndicator } from './pqr-estados.health';

function indicador(exec: jest.Mock) {
  const lean = jest.fn().mockReturnValue({ exec });
  const maxTimeMS = jest.fn().mockReturnValue({ lean });
  const findOne = jest.fn().mockReturnValue({ maxTimeMS });
  const modelo = { findOne } as unknown as Model<Pqr>;
  return {
    indicador: new PqrEstadosHealthIndicator(modelo),
    findOne,
    maxTimeMS,
  };
}

describe('PqrEstadosHealthIndicator', () => {
  it('con una PQR de estado anterior sigue up y deja la nota pendiente con el comando', async () => {
    const {
      indicador: i,
      findOne,
      maxTimeMS,
    } = indicador(jest.fn().mockResolvedValue({ _id: 'x' }));
    await expect(i.check('pqr-estados')).resolves.toEqual({
      'pqr-estados': {
        status: 'up',
        pendiente:
          'Hay PQRS con estados anteriores: ejecuta npm run migrar:estados-pqr -- --env=<ambiente> --aplicar',
      },
    });
    expect(findOne).toHaveBeenCalledWith(
      {
        estado: {
          $in: ['urgente', 'en_revision', 'pendiente', 'resuelto', 'cerrado'],
        },
      },
      { _id: 1 },
    );
    expect(maxTimeMS).toHaveBeenCalledWith(2000);
  });

  it('está up sin nota cuando no queda ninguna', async () => {
    const { indicador: i } = indicador(jest.fn().mockResolvedValue(null));
    await expect(i.check('pqr-estados')).resolves.toEqual({
      'pqr-estados': { status: 'up' },
    });
  });

  it('un error de Mongo o un timeout no escapa: up con omitido, sin eco del error', async () => {
    const { indicador: i } = indicador(
      jest.fn().mockRejectedValue(new Error('secreto mongodb://u:p@host')),
    );
    const resultado = await i.check('pqr-estados');
    expect(resultado).toEqual({
      'pqr-estados': {
        status: 'up',
        omitido: 'No se pudo comprobar los estados de PQRS.',
      },
    });
    expect(JSON.stringify(resultado)).not.toContain('secreto');
  });
});

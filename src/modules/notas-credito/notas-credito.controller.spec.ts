import { Types } from 'mongoose';
import { NotasCreditoController } from './notas-credito.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(
  notasCredito: Record<string, unknown>,
  presentacionDocumento: Record<string, unknown> = {
    buscar: jest.fn(() => Promise.resolve(null)),
  },
) {
  return new NotasCreditoController(
    notasCredito as never,
    presentacionDocumento as never,
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
      codigo: 'NC',
      inmuebleId: new Types.ObjectId().toString(),
      tipoDocumento: 'FV',
      documentoId: new Types.ObjectId().toString(),
      fecha: '2026-01-15',
      motivo: 'ajuste_precio',
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
      fecha: '2026-01-20',
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

describe('NotasCreditoController.obtenerDocumento', () => {
  const notaFixture = () => ({
    _id: new Types.ObjectId(),
    fullNumber: 'NC-001-0001',
  });

  it('devuelve el documentDefinition congelado, leído por (tipoDocumento, documentoId)', async () => {
    const nota = notaFixture();
    const notasCredito = {
      findOneRaw: jest.fn(() => Promise.resolve(nota)),
      resolverInmuebleCodigo: jest.fn(() => Promise.resolve('A-101')),
    };
    const presentacionDocumento = {
      buscar: jest.fn(() =>
        Promise.resolve({ type: 'VIEW', props: {} } as Record<string, unknown>),
      ),
    };
    const controller = makeController(notasCredito, presentacionDocumento);

    const respuesta = await controller.obtenerDocumento('nc-1');

    expect(presentacionDocumento.buscar).toHaveBeenCalledWith('NC', nota._id);
    expect(respuesta).toEqual({
      inmuebleCodigo: 'A-101',
      documentDefinition: { type: 'VIEW', props: {} },
    });
  });

  it('devuelve documentDefinition: null cuando nada fue congelado todavía, sin lanzar', async () => {
    const notasCredito = {
      findOneRaw: jest.fn(() => Promise.resolve(notaFixture())),
      resolverInmuebleCodigo: jest.fn(() => Promise.resolve('A-101')),
    };
    const presentacionDocumento = {
      buscar: jest.fn(() => Promise.resolve(null)),
    };
    const controller = makeController(notasCredito, presentacionDocumento);

    const respuesta = await controller.obtenerDocumento('nc-1');

    expect(respuesta).toEqual({
      inmuebleCodigo: 'A-101',
      documentDefinition: null,
    });
  });
});

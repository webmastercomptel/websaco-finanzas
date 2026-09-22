import { Types } from 'mongoose';
import { NotasAnticipoController } from './notas-anticipo.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(
  notasAnticipo: Record<string, unknown>,
  generacion: Record<string, unknown> = {
    solicitar: jest.fn(() =>
      Promise.resolve({
        plantilla: {
          tipoDocumento: 'NA',
          docDefinition: {},
          fechaActualizacion: '',
        },
        datos: {},
        objectPath: 'documentos-generados/x/NA/1.pdf',
        uploadUrl: 'https://upload',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    confirmar: jest.fn(() =>
      Promise.resolve({ objectPath: 'documentos-generados/x/NA/1.pdf' }),
    ),
    urlLectura: jest.fn(() =>
      Promise.resolve({
        url: 'https://x',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
  },
) {
  return new NotasAnticipoController(
    notasAnticipo as never,
    generacion as never,
  );
}

describe('NotasAnticipoController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const notasAnticipo = {
      crear: jest.fn(() => Promise.resolve({ id: 'na-1' })),
    };
    const controller = makeController(notasAnticipo);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      codigo: 'NA',
      reciboOrigenId: new Types.ObjectId().toString(),
      fechaEmision: '2026-09-01',
      aplicacionAutomatica: true,
    });

    expect(notasAnticipo.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('NotasAnticipoController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const notasAnticipo = {
      anular: jest.fn(() => Promise.resolve({ id: 'na-1', estado: 'anulado' })),
    };
    const controller = makeController(notasAnticipo);
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

    await controller.anular(user, 'na-1', dto);

    expect(notasAnticipo.anular).toHaveBeenCalledWith(
      'na-1',
      dto,
      user.accountId,
    );
  });
});

describe('NotasAnticipoController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const notasAnticipo = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(notasAnticipo);

    await controller.findAll({ estado: 'activo' });

    expect(notasAnticipo.findAll).toHaveBeenCalledWith({ estado: 'activo' });
  });

  it('findOne delega el id en el servicio — incluye objectPath/generatedAt, no hay ruta :id/pdf separada', async () => {
    const notasAnticipo = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'na-1', objectPath: null, generatedAt: null }),
      ),
    };
    const controller = makeController(notasAnticipo);

    await controller.findOne('na-1');

    expect(notasAnticipo.findOne).toHaveBeenCalledWith('na-1');
  });
});

describe('NotasAnticipoController.solicitarGeneracion', () => {
  it('junta la nota y sus datos de impresión, y delega en GeneracionDocumentoService', async () => {
    const nota = {
      _id: new Types.ObjectId(),
      coPropertyId: new Types.ObjectId(),
    };
    const datos = { tituloDocumento: 'Nota de Anticipo' };
    const notasAnticipo = {
      findOneRaw: jest.fn(() => Promise.resolve(nota)),
      datosImpresion: jest.fn(() => Promise.resolve(datos)),
    };
    const generacion = {
      solicitar: jest.fn(() =>
        Promise.resolve({
          plantilla: {
            tipoDocumento: 'NA',
            docDefinition: {},
            fechaActualizacion: '',
          },
          datos,
          objectPath: 'documentos-generados/x/NA/1.pdf',
          uploadUrl: 'https://upload',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    };
    const controller = makeController(notasAnticipo, generacion);

    const respuesta = await controller.solicitarGeneracion('na-1');

    expect(generacion.solicitar).toHaveBeenCalledWith('NA', nota, datos);
    expect(respuesta.objectPath).toBe('documentos-generados/x/NA/1.pdf');
  });
});

describe('NotasAnticipoController.confirmarGeneracion', () => {
  it('resuelve la nota por id y delega la confirmación en GeneracionDocumentoService', async () => {
    const nota = { _id: new Types.ObjectId() };
    const notasAnticipo = {
      findOneRaw: jest.fn(() => Promise.resolve(nota)),
    };
    const generacion = {
      confirmar: jest.fn(() =>
        Promise.resolve({ objectPath: 'documentos-generados/x/NA/1.pdf' }),
      ),
    };
    const controller = makeController(notasAnticipo, generacion);

    const respuesta = await controller.confirmarGeneracion('na-1', {
      objectPath: 'documentos-generados/x/NA/1.pdf',
    });

    expect(generacion.confirmar).toHaveBeenCalledWith(
      'NA',
      nota,
      'documentos-generados/x/NA/1.pdf',
    );
    expect(respuesta).toEqual({
      objectPath: 'documentos-generados/x/NA/1.pdf',
    });
  });
});

describe('NotasAnticipoController.urlLectura', () => {
  it('resuelve la nota por id y delega en GeneracionDocumentoService con la etiqueta correcta', async () => {
    const nota = {
      objectPath: 'documentos-generados/x/NA/1.pdf',
      generatedAt: new Date('2026-01-01'),
    };
    const notasAnticipo = {
      findOne: jest.fn(() => Promise.resolve(nota)),
    };
    const generacion = {
      urlLectura: jest.fn(() =>
        Promise.resolve({
          url: 'https://x',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    };
    const controller = makeController(notasAnticipo, generacion);

    await controller.urlLectura('na-1');

    expect(generacion.urlLectura).toHaveBeenCalledWith(
      'La nota de anticipo',
      'na-1',
      nota,
    );
  });
});

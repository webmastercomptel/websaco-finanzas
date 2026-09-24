import { Types } from 'mongoose';
import { NotasContablesController } from './notas-contables.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(
  notasContables: Record<string, unknown>,
  generacion: Record<string, unknown> = {
    solicitar: jest.fn(() =>
      Promise.resolve({
        plantilla: {
          tipoDocumento: 'NT',
          docDefinition: {},
          fechaActualizacion: '',
        },
        datos: {},
        objectPath: 'documentos-generados/x/NT/1.pdf',
        uploadUrl: 'https://upload',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    confirmar: jest.fn(() =>
      Promise.resolve({ objectPath: 'documentos-generados/x/NT/1.pdf' }),
    ),
    urlLectura: jest.fn(() =>
      Promise.resolve({
        url: 'https://x',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
  },
) {
  return new NotasContablesController(
    notasContables as never,
    generacion as never,
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

  it('findOne delega el id en el servicio — incluye objectPath/generatedAt, no hay ruta :id/pdf separada', async () => {
    const notasContables = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'nt-1', objectPath: null, generatedAt: null }),
      ),
    };
    const controller = makeController(notasContables);

    await controller.findOne('nt-1');

    expect(notasContables.findOne).toHaveBeenCalledWith('nt-1');
  });
});

describe('NotasContablesController.solicitarGeneracion', () => {
  it('junta la nota y sus datos de impresión, y delega en GeneracionDocumentoService', async () => {
    const nota = {
      _id: new Types.ObjectId(),
      coPropertyId: new Types.ObjectId(),
    };
    const datos = { tituloDocumento: 'Nota Contable' };
    const notasContables = {
      findOneRaw: jest.fn(() => Promise.resolve(nota)),
      datosImpresion: jest.fn(() => Promise.resolve(datos)),
    };
    const generacion = {
      solicitar: jest.fn(() =>
        Promise.resolve({
          plantilla: {
            tipoDocumento: 'NT',
            docDefinition: {},
            fechaActualizacion: '',
          },
          datos,
          objectPath: 'documentos-generados/x/NT/1.pdf',
          uploadUrl: 'https://upload',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    };
    const controller = makeController(notasContables, generacion);

    const respuesta = await controller.solicitarGeneracion('nt-1');

    expect(generacion.solicitar).toHaveBeenCalledWith('NT', nota, datos);
    expect(respuesta.objectPath).toBe('documentos-generados/x/NT/1.pdf');
  });
});

describe('NotasContablesController.confirmarGeneracion', () => {
  it('resuelve la nota por id y delega la confirmación en GeneracionDocumentoService', async () => {
    const nota = { _id: new Types.ObjectId() };
    const notasContables = {
      findOneRaw: jest.fn(() => Promise.resolve(nota)),
    };
    const generacion = {
      confirmar: jest.fn(() =>
        Promise.resolve({ objectPath: 'documentos-generados/x/NT/1.pdf' }),
      ),
    };
    const controller = makeController(notasContables, generacion);

    const respuesta = await controller.confirmarGeneracion('nt-1', {
      objectPath: 'documentos-generados/x/NT/1.pdf',
    });

    expect(generacion.confirmar).toHaveBeenCalledWith(
      'NT',
      nota,
      'documentos-generados/x/NT/1.pdf',
    );
    expect(respuesta).toEqual({
      objectPath: 'documentos-generados/x/NT/1.pdf',
    });
  });
});

describe('NotasContablesController.urlLectura', () => {
  it('resuelve la nota por id y delega en GeneracionDocumentoService con la etiqueta correcta', async () => {
    const nota = {
      objectPath: 'documentos-generados/x/NT/1.pdf',
      generatedAt: new Date('2026-01-01'),
    };
    const notasContables = {
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
    const controller = makeController(notasContables, generacion);

    await controller.urlLectura('nt-1');

    expect(generacion.urlLectura).toHaveBeenCalledWith(
      'La nota contable',
      'nt-1',
      nota,
    );
  });
});

describe('NotasContablesController.datosImpresion', () => {
  it('delega en NotasContablesService.datosImpresion, sin pasar por GeneracionDocumentoService', async () => {
    const datos = { tituloDocumento: 'Nota Contable' };
    const notasContables = {
      datosImpresion: jest.fn(() => Promise.resolve(datos)),
    };
    const controller = makeController(notasContables);

    const resultado = await controller.datosImpresion('nt-1');

    expect(notasContables.datosImpresion).toHaveBeenCalledWith('nt-1');
    expect(resultado).toBe(datos);
  });
});

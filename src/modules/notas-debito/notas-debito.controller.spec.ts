import { Types } from 'mongoose';
import { NotasDebitoController } from './notas-debito.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(
  notasDebito: Record<string, unknown>,
  generacion: Record<string, unknown> = {
    solicitar: jest.fn(() =>
      Promise.resolve({
        plantilla: {
          tipoDocumento: 'ND',
          docDefinition: {},
          fechaActualizacion: '',
        },
        datos: {},
        objectPath: 'documentos-generados/x/ND/1.pdf',
        uploadUrl: 'https://upload',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    confirmar: jest.fn(() =>
      Promise.resolve({ objectPath: 'documentos-generados/x/ND/1.pdf' }),
    ),
    urlLectura: jest.fn(() =>
      Promise.resolve({
        url: 'https://x',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
  },
) {
  return new NotasDebitoController(notasDebito as never, generacion as never);
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

  it('findOne delega el id en el servicio — incluye objectPath/generatedAt, no hay ruta :id/pdf separada', async () => {
    const notasDebito = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'nd-1', objectPath: null, generatedAt: null }),
      ),
    };
    const controller = makeController(notasDebito);

    await controller.findOne('nd-1');

    expect(notasDebito.findOne).toHaveBeenCalledWith('nd-1');
  });
});

describe('NotasDebitoController.solicitarGeneracion', () => {
  it('junta la nota y sus datos de impresión, y delega en GeneracionDocumentoService', async () => {
    const nota = {
      _id: new Types.ObjectId(),
      coPropertyId: new Types.ObjectId(),
    };
    const datos = { tituloDocumento: 'Nota Débito' };
    const notasDebito = {
      findOneRaw: jest.fn(() => Promise.resolve(nota)),
      datosImpresion: jest.fn(() => Promise.resolve(datos)),
    };
    const generacion = {
      solicitar: jest.fn(() =>
        Promise.resolve({
          plantilla: {
            tipoDocumento: 'ND',
            docDefinition: {},
            fechaActualizacion: '',
          },
          datos,
          objectPath: 'documentos-generados/x/ND/1.pdf',
          uploadUrl: 'https://upload',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    };
    const controller = makeController(notasDebito, generacion);

    const respuesta = await controller.solicitarGeneracion('nd-1');

    expect(generacion.solicitar).toHaveBeenCalledWith('ND', nota, datos);
    expect(respuesta.objectPath).toBe('documentos-generados/x/ND/1.pdf');
  });
});

describe('NotasDebitoController.confirmarGeneracion', () => {
  it('resuelve la nota por id y delega la confirmación en GeneracionDocumentoService', async () => {
    const nota = { _id: new Types.ObjectId() };
    const notasDebito = { findOneRaw: jest.fn(() => Promise.resolve(nota)) };
    const generacion = {
      confirmar: jest.fn(() =>
        Promise.resolve({ objectPath: 'documentos-generados/x/ND/1.pdf' }),
      ),
    };
    const controller = makeController(notasDebito, generacion);

    const respuesta = await controller.confirmarGeneracion('nd-1', {
      objectPath: 'documentos-generados/x/ND/1.pdf',
    });

    expect(generacion.confirmar).toHaveBeenCalledWith(
      'ND',
      nota,
      'documentos-generados/x/ND/1.pdf',
    );
    expect(respuesta).toEqual({
      objectPath: 'documentos-generados/x/ND/1.pdf',
    });
  });
});

describe('NotasDebitoController.urlLectura', () => {
  it('resuelve la nota por id y delega en GeneracionDocumentoService con la etiqueta correcta', async () => {
    const nota = {
      objectPath: 'documentos-generados/x/ND/1.pdf',
      generatedAt: new Date('2026-01-01'),
    };
    const notasDebito = {
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
    const controller = makeController(notasDebito, generacion);

    await controller.urlLectura('nd-1');

    expect(generacion.urlLectura).toHaveBeenCalledWith(
      'La nota débito',
      'nd-1',
      nota,
    );
  });
});

describe('NotasDebitoController.datosImpresion', () => {
  it('delega en NotasDebitoService.datosImpresion, sin pasar por GeneracionDocumentoService', async () => {
    const datos = { tituloDocumento: 'Nota de Débito' };
    const notasDebito = {
      datosImpresion: jest.fn(() => Promise.resolve(datos)),
    };
    const controller = makeController(notasDebito);

    const resultado = await controller.datosImpresion('nd-1');

    expect(notasDebito.datosImpresion).toHaveBeenCalledWith('nd-1');
    expect(resultado).toBe(datos);
  });
});

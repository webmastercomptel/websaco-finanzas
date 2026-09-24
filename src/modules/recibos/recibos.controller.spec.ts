import { Types } from 'mongoose';
import { RecibosController } from './recibos.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(
  recibos: Record<string, unknown>,
  generacion: Record<string, unknown> = {
    solicitar: jest.fn(() =>
      Promise.resolve({
        plantilla: {
          tipoDocumento: 'RC',
          docDefinition: {},
          fechaActualizacion: '',
        },
        datos: {},
        objectPath: 'documentos-generados/x/RC/1.pdf',
        uploadUrl: 'https://upload',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    confirmar: jest.fn(() =>
      Promise.resolve({ objectPath: 'documentos-generados/x/RC/1.pdf' }),
    ),
    urlLectura: jest.fn(() =>
      Promise.resolve({
        url: 'https://x',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
  },
) {
  return new RecibosController(recibos as never, generacion as never);
}

describe('RecibosController.crear', () => {
  it('pasa el accountId del caller autenticado, nunca uno del body', async () => {
    const recibos = { crear: jest.fn(() => Promise.resolve({ id: 'rec-1' })) };
    const controller = makeController(recibos);
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.crear(user, {
      codigo: 'RC',
      inmuebleId: new Types.ObjectId().toString(),
      terceroId: new Types.ObjectId().toString(),
      montoRecibido: 100000,
      fechaRecibo: '2026-08-27',
      medioPago: 'efectivo',
      cuentaDestino: 'caja-1',
    });

    expect(recibos.crear).toHaveBeenCalledWith(
      user.accountId,
      expect.any(Object),
    );
  });
});

describe('RecibosController.anular', () => {
  it('delega en el servicio con el id de ruta, el dto y el accountId del caller', async () => {
    const recibos = {
      anular: jest.fn(() =>
        Promise.resolve({ id: 'rec-1', estado: 'anulado' }),
      ),
    };
    const controller = makeController(recibos);
    const dto = {
      motivo: 'otro' as const,
      detalle: 'Un detalle de más de veinte caracteres',
      fecha: '2026-09-01',
    };
    const user: IRequestUser = {
      uid: 'uid-1',
      email: 'a@b.com',
      accountId: new Types.ObjectId().toString(),
    };

    await controller.anular(user, 'rec-1', dto);

    expect(recibos.anular).toHaveBeenCalledWith('rec-1', dto, user.accountId);
  });
});

describe('RecibosController.findAll / findOne', () => {
  it('findAll delega la query en el servicio', async () => {
    const recibos = {
      findAll: jest.fn(() =>
        Promise.resolve({ items: [], total: 0, pagina: 1, porPagina: 50 }),
      ),
    };
    const controller = makeController(recibos);

    await controller.findAll({ estado: 'activo' });

    expect(recibos.findAll).toHaveBeenCalledWith({ estado: 'activo' });
  });

  it('findOne delega el id en el servicio — incluye objectPath/generatedAt, no hay ruta :id/pdf separada', async () => {
    const recibos = {
      findOne: jest.fn(() =>
        Promise.resolve({ id: 'rec-1', objectPath: null, generatedAt: null }),
      ),
    };
    const controller = makeController(recibos);

    await controller.findOne('rec-1');

    expect(recibos.findOne).toHaveBeenCalledWith('rec-1');
  });
});

describe('RecibosController.solicitarGeneracion', () => {
  it('junta el recibo y sus datos de impresión, y delega en GeneracionDocumentoService', async () => {
    const recibo = {
      _id: new Types.ObjectId(),
      coPropertyId: new Types.ObjectId(),
    };
    const datos = { tituloDocumento: 'Recibo de Caja' };
    const recibos = {
      findOneRaw: jest.fn(() => Promise.resolve(recibo)),
      datosImpresion: jest.fn(() => Promise.resolve(datos)),
    };
    const generacion = {
      solicitar: jest.fn(() =>
        Promise.resolve({
          plantilla: {
            tipoDocumento: 'RC',
            docDefinition: {},
            fechaActualizacion: '',
          },
          datos,
          objectPath: 'documentos-generados/x/RC/1.pdf',
          uploadUrl: 'https://upload',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    };
    const controller = makeController(recibos, generacion);

    const respuesta = await controller.solicitarGeneracion('rec-1');

    expect(generacion.solicitar).toHaveBeenCalledWith('RC', recibo, datos);
    expect(respuesta.objectPath).toBe('documentos-generados/x/RC/1.pdf');
  });
});

describe('RecibosController.confirmarGeneracion', () => {
  it('resuelve el recibo por id y delega la confirmación en GeneracionDocumentoService', async () => {
    const recibo = { _id: new Types.ObjectId() };
    const recibos = { findOneRaw: jest.fn(() => Promise.resolve(recibo)) };
    const generacion = {
      confirmar: jest.fn(() =>
        Promise.resolve({ objectPath: 'documentos-generados/x/RC/1.pdf' }),
      ),
    };
    const controller = makeController(recibos, generacion);

    const respuesta = await controller.confirmarGeneracion('rec-1', {
      objectPath: 'documentos-generados/x/RC/1.pdf',
    });

    expect(generacion.confirmar).toHaveBeenCalledWith(
      'RC',
      recibo,
      'documentos-generados/x/RC/1.pdf',
    );
    expect(respuesta).toEqual({
      objectPath: 'documentos-generados/x/RC/1.pdf',
    });
  });
});

describe('RecibosController.urlLectura', () => {
  it('resuelve el recibo por id y delega en GeneracionDocumentoService con la etiqueta correcta', async () => {
    const recibo = {
      objectPath: 'documentos-generados/x/RC/1.pdf',
      generatedAt: new Date('2026-01-01'),
    };
    const recibos = {
      findOne: jest.fn(() => Promise.resolve(recibo)),
    };
    const generacion = {
      urlLectura: jest.fn(() =>
        Promise.resolve({
          url: 'https://x',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    };
    const controller = makeController(recibos, generacion);

    await controller.urlLectura('rec-1');

    expect(generacion.urlLectura).toHaveBeenCalledWith(
      'El recibo',
      'rec-1',
      recibo,
    );
  });
});

describe('RecibosController.datosImpresion', () => {
  it('delega en RecibosService.datosImpresion, sin pasar por GeneracionDocumentoService', async () => {
    const datos = { tituloDocumento: 'Recibo de Caja' };
    const recibos = { datosImpresion: jest.fn(() => Promise.resolve(datos)) };
    const controller = makeController(recibos);

    const resultado = await controller.datosImpresion('rec-1');

    expect(recibos.datosImpresion).toHaveBeenCalledWith('rec-1');
    expect(resultado).toBe(datos);
  });
});

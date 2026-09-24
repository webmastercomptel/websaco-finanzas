import { Types } from 'mongoose';
import { NotasCreditoController } from './notas-credito.controller';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

function makeController(
  notasCredito: Record<string, unknown>,
  generacion: Record<string, unknown> = {
    solicitar: jest.fn(() =>
      Promise.resolve({
        plantilla: {
          tipoDocumento: 'NC',
          docDefinition: {},
          fechaActualizacion: '',
        },
        datos: {},
        objectPath: 'documentos-generados/x/NC/1.pdf',
        uploadUrl: 'https://upload',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
    confirmar: jest.fn(() =>
      Promise.resolve({ objectPath: 'documentos-generados/x/NC/1.pdf' }),
    ),
    urlLectura: jest.fn(() =>
      Promise.resolve({
        url: 'https://x',
        expiresAt: '2026-01-01T00:00:00.000Z',
      }),
    ),
  },
) {
  return new NotasCreditoController(notasCredito as never, generacion as never);
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

describe('NotasCreditoController.solicitarGeneracion', () => {
  const notaFixture = () => ({
    _id: new Types.ObjectId(),
    coPropertyId: new Types.ObjectId(),
    fullNumber: 'NC-001-0001',
  });

  it('junta la nota y sus datos de impresión, y delega en GeneracionDocumentoService', async () => {
    const nota = notaFixture();
    const datos = { tituloDocumento: 'Nota Crédito' };
    const notasCredito = {
      findOneRaw: jest.fn(() => Promise.resolve(nota)),
      datosImpresion: jest.fn(() => Promise.resolve(datos)),
    };
    const generacion = {
      solicitar: jest.fn(() =>
        Promise.resolve({
          plantilla: {
            tipoDocumento: 'NC',
            docDefinition: {},
            fechaActualizacion: '',
          },
          datos,
          objectPath: 'documentos-generados/x/NC/1.pdf',
          uploadUrl: 'https://upload',
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    };
    const controller = makeController(notasCredito, generacion);

    const respuesta = await controller.solicitarGeneracion('nc-1');

    expect(generacion.solicitar).toHaveBeenCalledWith('NC', nota, datos);
    expect(respuesta.objectPath).toBe('documentos-generados/x/NC/1.pdf');
    expect(respuesta.uploadUrl).toBe('https://upload');
    expect(respuesta.datos).toEqual({ tituloDocumento: 'Nota Crédito' });
  });
});

describe('NotasCreditoController.confirmarGeneracion', () => {
  it('resuelve la nota por id y delega la confirmación en GeneracionDocumentoService', async () => {
    const nota = { _id: new Types.ObjectId() };
    const notasCredito = { findOneRaw: jest.fn(() => Promise.resolve(nota)) };
    const generacion = {
      confirmar: jest.fn(() =>
        Promise.resolve({ objectPath: 'documentos-generados/x/NC/1.pdf' }),
      ),
    };
    const controller = makeController(notasCredito, generacion);

    const respuesta = await controller.confirmarGeneracion('nc-1', {
      objectPath: 'documentos-generados/x/NC/1.pdf',
    });

    expect(generacion.confirmar).toHaveBeenCalledWith(
      'NC',
      nota,
      'documentos-generados/x/NC/1.pdf',
    );
    expect(respuesta).toEqual({
      objectPath: 'documentos-generados/x/NC/1.pdf',
    });
  });
});

describe('NotasCreditoController.urlLectura', () => {
  it('resuelve la nota por id y delega en GeneracionDocumentoService con la etiqueta correcta', async () => {
    const nota = {
      objectPath: 'documentos-generados/x/NC/1.pdf',
      generatedAt: new Date('2026-01-01'),
    };
    const notasCredito = {
      findOne: jest.fn(() => Promise.resolve(nota)),
    };
    const generacion = {
      urlLectura: jest.fn(() =>
        Promise.resolve({
          url: 'https://read',
          expiresAt: '2026-01-01T00:10:00.000Z',
        }),
      ),
    };
    const controller = makeController(notasCredito, generacion);

    const respuesta = await controller.urlLectura('nc-1');

    expect(generacion.urlLectura).toHaveBeenCalledWith(
      'La nota crédito',
      'nc-1',
      nota,
    );
    expect(respuesta.url).toBe('https://read');
  });
});

describe('NotasCreditoController.datosImpresion', () => {
  it('delega en NotasCreditoService.datosImpresion, sin pasar por GeneracionDocumentoService', async () => {
    const datos = { tituloDocumento: 'Nota de Crédito' };
    const notasCredito = {
      datosImpresion: jest.fn(() => Promise.resolve(datos)),
    };
    const controller = makeController(notasCredito);

    const resultado = await controller.datosImpresion('nc-1');

    expect(notasCredito.datosImpresion).toHaveBeenCalledWith('nc-1');
    expect(resultado).toBe(datos);
  });
});

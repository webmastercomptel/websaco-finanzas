import { Types } from 'mongoose';
import { GeneracionDocumentoService } from './generacion-documento.service';

function makeService(
  presentacionDocumento: Record<string, unknown> = {},
  plantillas: Record<string, unknown> = {},
  storage: Record<string, unknown> = {},
) {
  return new GeneracionDocumentoService(
    presentacionDocumento as never,
    plantillas as never,
    storage as never,
  );
}

describe('GeneracionDocumentoService.solicitar', () => {
  it('pide la plantilla del tipo, pasa su versión a la solicitud de generación, y arma la respuesta con los datos ya calculados del caller', async () => {
    const doc = {
      _id: new Types.ObjectId(),
      coPropertyId: new Types.ObjectId(),
    };
    const datos = { tituloDocumento: 'Recibo de Caja' };
    const plantillas = {
      findOne: jest.fn(() =>
        Promise.resolve({
          tipoDocumento: 'RC',
          version: 3,
          docDefinition: { content: [] },
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ),
    };
    const presentacionDocumento = {
      solicitarGeneracion: jest.fn(() =>
        Promise.resolve({
          objectPath: 'documentos-generados/x/RC/1.pdf',
          uploadUrl: 'https://upload',
          expiresAt: new Date('2026-01-01T00:05:00.000Z'),
        }),
      ),
    };
    const service = makeService(presentacionDocumento, plantillas);

    const respuesta = await service.solicitar('RC', doc, datos);

    expect(plantillas.findOne).toHaveBeenCalledWith('RC');
    expect(presentacionDocumento.solicitarGeneracion).toHaveBeenCalledWith(
      'RC',
      doc._id,
      doc.coPropertyId,
      3,
    );
    expect(respuesta).toEqual({
      plantilla: {
        tipoDocumento: 'RC',
        version: 3,
        docDefinition: { content: [] },
        fechaActualizacion: '2026-01-01T00:00:00.000Z',
      },
      datos,
      objectPath: 'documentos-generados/x/RC/1.pdf',
      uploadUrl: 'https://upload',
      expiresAt: '2026-01-01T00:05:00.000Z',
    });
  });
});

describe('GeneracionDocumentoService.confirmar', () => {
  it('delega en PresentacionDocumentoService.confirmarGeneracion y devuelve el objectPath', async () => {
    const doc = { _id: new Types.ObjectId() };
    const presentacionDocumento = {
      confirmarGeneracion: jest.fn(() => Promise.resolve()),
    };
    const service = makeService(presentacionDocumento);

    const respuesta = await service.confirmar(
      'RC',
      doc,
      'documentos-generados/x/RC/1.pdf',
    );

    expect(presentacionDocumento.confirmarGeneracion).toHaveBeenCalledWith(
      'RC',
      doc._id,
      'documentos-generados/x/RC/1.pdf',
    );
    expect(respuesta).toEqual({
      objectPath: 'documentos-generados/x/RC/1.pdf',
    });
  });
});

describe('GeneracionDocumentoService.urlLectura', () => {
  it('rechaza con 404 cuando el documento todavía no tiene objectPath/generatedAt', async () => {
    const service = makeService();

    await expect(
      service.urlLectura('El recibo', 'rec-1', {
        objectPath: null,
        generatedAt: null,
      }),
    ).rejects.toThrow('El recibo rec-1 todavía no tiene un documento generado');
  });

  it('rechaza con 404 cuando falta generatedAt aunque objectPath ya esté seteado', async () => {
    const service = makeService();

    await expect(
      service.urlLectura('El recibo', 'rec-1', {
        objectPath: 'documentos-generados/x/RC/1.pdf',
        generatedAt: null,
      }),
    ).rejects.toThrow();
  });

  it('devuelve la url firmada cuando el documento ya está confirmado', async () => {
    const storage = {
      generarUrlLectura: jest.fn(() =>
        Promise.resolve({
          url: 'https://read',
          expiresAt: new Date('2026-01-01T00:10:00.000Z'),
        }),
      ),
    };
    const service = makeService({}, {}, storage);

    const respuesta = await service.urlLectura('El recibo', 'rec-1', {
      objectPath: 'documentos-generados/x/RC/1.pdf',
      generatedAt: new Date('2026-01-01'),
    });

    expect(storage.generarUrlLectura).toHaveBeenCalledWith(
      'documentos-generados/x/RC/1.pdf',
    );
    expect(respuesta).toEqual({
      url: 'https://read',
      expiresAt: '2026-01-01T00:10:00.000Z',
    });
  });
});

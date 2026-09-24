import { PlantillaDocumentoService } from './plantilla-documento.service';

function makeService(model: Record<string, unknown>) {
  return new PlantillaDocumentoService(model as never);
}

describe('PlantillaDocumentoService.upsert', () => {
  it('inserta version 1 cuando no hay ninguna plantilla previa del tipo', async () => {
    const model = {
      findOne: jest.fn(() => ({
        sort: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      })),
      create: jest.fn((doc) => Promise.resolve(doc)),
    };
    const service = makeService(model);

    const resultado = await service.upsert('FV', { content: [] });

    expect(model.create).toHaveBeenCalledWith({
      tipoDocumento: 'FV',
      version: 1,
      docDefinition: { content: [] },
    });
    expect(resultado).toMatchObject({ version: 1 });
  });

  it('inserta la siguiente version en vez de sobreescribir la existente', async () => {
    const model = {
      findOne: jest.fn(() => ({
        sort: jest.fn(() => ({
          exec: () => Promise.resolve({ version: 4 }),
        })),
      })),
      create: jest.fn((doc) => Promise.resolve(doc)),
    };
    const service = makeService(model);

    await service.upsert('FV', { content: [] });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ version: 5 }),
    );
  });
});

describe('PlantillaDocumentoService.findOne', () => {
  it('devuelve la version mas alta ordenando por version descendente', async () => {
    const sort = jest.fn(() => ({
      exec: () => Promise.resolve({ tipoDocumento: 'FV', version: 7 }),
    }));
    const model = { findOne: jest.fn(() => ({ sort })) };
    const service = makeService(model);

    const resultado = await service.findOne('FV');

    expect(sort).toHaveBeenCalledWith({ version: -1 });
    expect(resultado).toEqual({ tipoDocumento: 'FV', version: 7 });
  });

  it('lanza NotFoundException cuando el tipo no tiene ninguna plantilla', async () => {
    const model = {
      findOne: jest.fn(() => ({
        sort: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      })),
    };
    const service = makeService(model);

    await expect(service.findOne('FV')).rejects.toThrow(
      'No hay plantilla configurada',
    );
  });
});

describe('PlantillaDocumentoService.findVersion', () => {
  it('devuelve exactamente la version pedida', async () => {
    const findOne = jest.fn(() => ({
      exec: () => Promise.resolve({ tipoDocumento: 'FV', version: 3 }),
    }));
    const model = { findOne };
    const service = makeService(model);

    const resultado = await service.findVersion('FV', 3);

    expect(findOne).toHaveBeenCalledWith({ tipoDocumento: 'FV', version: 3 });
    expect(resultado).toEqual({ tipoDocumento: 'FV', version: 3 });
  });

  it('lanza NotFoundException cuando esa version especifica no existe', async () => {
    const model = {
      findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const service = makeService(model);

    await expect(service.findVersion('FV', 99)).rejects.toThrow(
      'No existe la versión 99',
    );
  });
});

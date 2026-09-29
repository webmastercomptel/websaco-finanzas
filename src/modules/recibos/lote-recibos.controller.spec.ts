import { Types } from 'mongoose';
import { LoteRecibosController } from './lote-recibos.controller';

const COPROPERTY_ID = new Types.ObjectId();
const LOTE_ID = new Types.ObjectId();
const RECIBO_ID_1 = new Types.ObjectId();
const RECIBO_ID_2 = new Types.ObjectId();

const construirController = (
  filas: { reciboId: Types.ObjectId | null }[],
  overrides: Partial<{
    generacion: Record<string, jest.Mock>;
    presentacionDocumento: Record<string, jest.Mock>;
    recibosService: Record<string, jest.Mock>;
  }> = {},
) => {
  const loteDoc = { _id: LOTE_ID, coPropertyId: COPROPERTY_ID, filas };
  const loteRecibos = {
    findOneRaw: jest.fn().mockResolvedValue(loteDoc),
  };
  const presentacionDocumento = {
    buscarVarios: jest.fn(),
    buscar: jest.fn(),
    ...overrides.presentacionDocumento,
  };
  const recibosService = {
    datosImpresion: jest
      .fn()
      .mockImplementation((id: string) => Promise.resolve({ id })),
    ...overrides.recibosService,
  };
  const generacion = {
    solicitar: jest.fn().mockResolvedValue({
      plantilla: { tipoDocumento: 'RC', docDefinition: {}, version: 1 },
      objectPath: 'documentos-generados/x/RC/lote-1.pdf',
      uploadUrl: 'https://signed-url',
      expiresAt: '2026-09-29T00:00:00.000Z',
    }),
    confirmar: jest.fn().mockResolvedValue({ objectPath: 'x' }),
    urlLectura: jest
      .fn()
      .mockResolvedValue({
        url: 'https://read-url',
        expiresAt: '2026-09-29T00:00:00.000Z',
      }),
    ...overrides.generacion,
  };

  const controller = new LoteRecibosController(
    loteRecibos as never,
    presentacionDocumento as never,
    recibosService as never,
    generacion as never,
  );
  return {
    controller,
    loteRecibos,
    presentacionDocumento,
    recibosService,
    generacion,
  };
};

describe('LoteRecibosController.solicitarGeneracionRecibos', () => {
  it('junta datosImpresion de cada recibo del lote y llama a generacion.solicitar con el código RC (mismo que el Recibo individual, keyed por el _id del lote)', async () => {
    const { controller, generacion, recibosService } = construirController([
      { reciboId: RECIBO_ID_1 },
      { reciboId: RECIBO_ID_2 },
    ]);

    const resultado = await controller.solicitarGeneracionRecibos(
      LOTE_ID.toString(),
    );

    expect(recibosService.datosImpresion).toHaveBeenCalledTimes(2);
    expect(generacion.solicitar).toHaveBeenCalledWith(
      'RC',
      expect.objectContaining({ _id: LOTE_ID, coPropertyId: COPROPERTY_ID }),
      expect.arrayContaining([
        expect.objectContaining({ reciboId: RECIBO_ID_1.toString() }),
        expect.objectContaining({ reciboId: RECIBO_ID_2.toString() }),
      ]),
    );
    expect(resultado.recibos).toHaveLength(2);
  });

  it('404 cuando el lote todavía no tiene ningún recibo generado', async () => {
    const { controller } = construirController([{ reciboId: null }]);

    await expect(
      controller.solicitarGeneracionRecibos(LOTE_ID.toString()),
    ).rejects.toThrow('todavía no tiene recibos generados');
  });
});

describe('LoteRecibosController.confirmarGeneracionRecibos', () => {
  it('delega en generacion.confirmar con el código RC', async () => {
    const { controller, generacion } = construirController([
      { reciboId: RECIBO_ID_1 },
    ]);

    const resultado = await controller.confirmarGeneracionRecibos(
      LOTE_ID.toString(),
      { objectPath: 'documentos-generados/x/RC/lote-1.pdf' },
    );

    expect(generacion.confirmar).toHaveBeenCalledWith(
      'RC',
      expect.objectContaining({ _id: LOTE_ID }),
      'documentos-generados/x/RC/lote-1.pdf',
    );
    expect(resultado).toEqual({ objectPath: 'x' });
  });
});

describe('LoteRecibosController.urlLecturaRecibos', () => {
  it('busca la presentación con el código RC keyed por el _id del lote, y delega en generacion.urlLectura', async () => {
    const { controller, presentacionDocumento, generacion } =
      construirController([{ reciboId: RECIBO_ID_1 }]);
    presentacionDocumento.buscar.mockResolvedValue({
      objectPath: 'x',
      generatedAt: new Date(),
      plantillaVersion: 1,
    });

    await controller.urlLecturaRecibos(LOTE_ID.toString());

    expect(presentacionDocumento.buscar).toHaveBeenCalledWith('RC', LOTE_ID);
    expect(generacion.urlLectura).toHaveBeenCalledWith(
      'El lote de recibos',
      LOTE_ID.toString(),
      expect.objectContaining({ objectPath: 'x' }),
    );
  });
});

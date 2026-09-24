import { Types } from 'mongoose';

// `LotesController` statically imports `generarPdfConsultaFacturacion`,
// which pulls in `@react-pdf/renderer`'s full render tree
// (`@react-pdf/textkit` → `@react-pdf/hyphenate`) — a dependency chain that
// fails to resolve under Jest in this environment, unrelated to anything
// under test here. Mocked out so importing the controller module doesn't
// require actually loading that tree; nothing in this spec calls the PDF
// endpoint.
jest.mock('../../common/pdf/consulta-facturacion-pdf', () => ({
  generarPdfConsultaFacturacion: jest.fn(),
}));

import { LotesController } from './lotes.controller';
import { LOTE_FACTURAS_PDF_CONFIRMADO } from '../../common/eventos/lote-facturas-pdf-confirmado.event';

const COPROPERTY_ID = new Types.ObjectId('507f1f77bcf86cd799439011');
const LOTE_ID = new Types.ObjectId('507f1f77bcf86cd799439012');

const mockLotes = (lote: Record<string, unknown>) => ({
  findOneRaw: jest.fn().mockResolvedValue(lote),
});

const mockFacturas = (facturasLean: Record<string, unknown>[]) => ({
  findAllRawPorLote: jest.fn().mockResolvedValue(facturasLean),
  datosVisualesPdf: jest.fn().mockResolvedValue(new Map()),
  datosPlantilla: jest.fn().mockResolvedValue({}),
  guardarPrintSnapshot: jest.fn().mockResolvedValue(undefined),
});

const mockTenant = () => ({
  resolveCoPropertyId: jest.fn(() => COPROPERTY_ID),
});

const mockCopropiedadesModel = () => ({
  findById: jest.fn(() => ({
    exec: () => Promise.resolve({ _id: COPROPERTY_ID }),
  })),
});

const mockGeneracion = (objectPath: string) => ({
  confirmar: jest.fn().mockResolvedValue({ objectPath }),
});

const mockEventos = () => ({
  emitAsync: jest.fn().mockResolvedValue([]),
});

const construirController = (
  facturasLean: Record<string, unknown>[],
  objectPath = 'coproprietats/cop-1/lotes/lote-1.pdf',
) => {
  const lote = mockLotes({ _id: LOTE_ID });
  const facturas = mockFacturas(facturasLean);
  const generacion = mockGeneracion(objectPath);
  const eventos = mockEventos();
  const controller = new LotesController(
    lote as never,
    facturas as never,
    {} as never, // ConsultaFacturacionService — no ejercitado en este test
    mockTenant() as never,
    mockCopropiedadesModel() as never,
    {} as never, // PresentacionDocumentoService — no ejercitado en este test
    {} as never, // PlantillaDocumentoService — no ejercitado en este test
    generacion as never,
    eventos as never,
  );
  return { controller, eventos, generacion, objectPath };
};

describe('LotesController.confirmarGeneracionFacturas', () => {
  const facturaLean = (over: Record<string, unknown>) => ({
    _id: new Types.ObjectId(),
    inmuebleId: new Types.ObjectId(),
    ...over,
  });

  it('emite LOTE_FACTURAS_PDF_CONFIRMADO con los números de factura en el mismo orden que facturasLean', async () => {
    const facturasLean = [
      facturaLean({ fullNumber: 'FV-1', unitCode: 'A-101' }),
      facturaLean({ fullNumber: 'FV-2', unitCode: 'A-102' }),
      facturaLean({ fullNumber: 'FV-3', unitCode: 'A-103' }),
    ];
    const { controller, eventos, objectPath } =
      construirController(facturasLean);

    await controller.confirmarGeneracionFacturas(LOTE_ID.toString(), {
      objectPath,
    });

    expect(eventos.emitAsync).toHaveBeenCalledWith(
      LOTE_FACTURAS_PDF_CONFIRMADO,
      {
        coPropertyId: COPROPERTY_ID.toString(),
        loteId: LOTE_ID.toString(),
        objectPath,
        numerosFactura: ['FV-1', 'FV-2', 'FV-3'],
      },
    );
  });

  it('el emit se dispara aunque no haya facturas (array vacío)', async () => {
    const { controller, eventos, objectPath } = construirController([]);

    await controller.confirmarGeneracionFacturas(LOTE_ID.toString(), {
      objectPath,
    });

    expect(eventos.emitAsync).toHaveBeenCalledWith(
      LOTE_FACTURAS_PDF_CONFIRMADO,
      expect.objectContaining({ numerosFactura: [] }),
    );
  });

  it('espera (await) el emitAsync antes de devolver el resultado', async () => {
    const facturasLean = [
      facturaLean({ fullNumber: 'FV-1', unitCode: 'A-101' }),
    ];
    const { controller, eventos, objectPath } =
      construirController(facturasLean);
    let resueltoAntesDeEmitir = false;
    eventos.emitAsync.mockImplementation(async () => {
      await Promise.resolve();
      resueltoAntesDeEmitir = true;
      return [];
    });

    const resultado = await controller.confirmarGeneracionFacturas(
      LOTE_ID.toString(),
      { objectPath },
    );

    expect(resueltoAntesDeEmitir).toBe(true);
    expect(resultado).toEqual({ objectPath });
  });
});

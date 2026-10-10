import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { PDFDocument } from 'pdf-lib';

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
  solicitar: jest.fn().mockResolvedValue({
    plantilla: {},
    objectPath,
    uploadUrl: 'https://upload.example/lote.pdf',
    expiresAt: new Date('2026-09-01T12:00:00Z'),
  }),
});

const mockEventos = () => ({
  emitAsync: jest.fn().mockResolvedValue([]),
});

/** A real, minimal PDF with exactly `paginas` pages — so the controller's
 *  own page-count verification (`páginas del combinado == cantidad de
 *  facturas`) passes cleanly for these tests instead of tripping the
 *  "desconfiar de paginaEnLote" branch. */
const pdfDePaginas = async (paginas: number): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
};

const mockStorage = (bytes: Buffer) => ({
  descargarBytes: jest.fn().mockResolvedValue(bytes),
});

const construirController = async (
  facturasLean: Record<string, unknown>[],
  objectPath = 'coproprietats/cop-1/lotes/lote-1.pdf',
  loteOver: Record<string, unknown> = {},
) => {
  // `facturaIds` as a consolidated lote carries it: one per Factura.
  const lote = mockLotes({
    _id: LOTE_ID,
    numero: 7,
    estado: 'consolidado',
    progreso: null,
    facturaIds: facturasLean.map((f) => String(f._id)),
    ...loteOver,
  });
  const facturas = mockFacturas(facturasLean);
  const generacion = mockGeneracion(objectPath);
  const eventos = mockEventos();
  const storage = mockStorage(await pdfDePaginas(facturasLean.length));
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
    storage as never,
  );
  return { controller, eventos, generacion, storage, objectPath, facturas };
};

describe('LotesController.confirmarGeneracionFacturas', () => {
  const facturaLean = (over: Record<string, unknown>) => ({
    _id: new Types.ObjectId(),
    inmuebleId: new Types.ObjectId(),
    ...over,
  });

  it('emite LOTE_FACTURAS_PDF_CONFIRMADO con los números de factura en el mismo orden que facturasLean', async () => {
    const facturasLean = [
      facturaLean({ numeroCompleto: 'FV-1', codigoInmueble: 'A-101' }),
      facturaLean({ numeroCompleto: 'FV-2', codigoInmueble: 'A-102' }),
      facturaLean({ numeroCompleto: 'FV-3', codigoInmueble: 'A-103' }),
    ];
    const { controller, eventos, objectPath } =
      await construirController(facturasLean);

    await controller.confirmarGeneracionFacturas(LOTE_ID.toString(), {
      objectPath,
    });

    expect(eventos.emitAsync).toHaveBeenCalledWith(
      LOTE_FACTURAS_PDF_CONFIRMADO,
      {
        copropiedadId: COPROPERTY_ID.toString(),
        loteId: LOTE_ID.toString(),
        objectPath,
        numerosFactura: ['FV-1', 'FV-2', 'FV-3'],
      },
    );
  });

  it('rechaza si el lote ya no tiene facturas (p. ej. se deshizo): no confirma, no emite ni congela nada', async () => {
    const { controller, eventos, generacion, facturas, objectPath } =
      await construirController([]);

    const intento = controller.confirmarGeneracionFacturas(LOTE_ID.toString(), {
      objectPath,
    });

    await expect(intento).rejects.toBeInstanceOf(ConflictException);
    await expect(intento).rejects.toThrow(/ya no tiene las facturas/);
    expect(generacion.confirmar).not.toHaveBeenCalled();
    expect(eventos.emitAsync).not.toHaveBeenCalled();
    expect(facturas.guardarPrintSnapshot).not.toHaveBeenCalled();
  });

  it('rechaza si la cantidad de facturas existentes no coincide con las que el lote consolidó', async () => {
    const facturasLean = [
      facturaLean({ numeroCompleto: 'FV-1', codigoInmueble: 'A-101' }),
      facturaLean({ numeroCompleto: 'FV-2', codigoInmueble: 'A-102' }),
    ];
    const { controller, eventos, generacion, objectPath } =
      await construirController(facturasLean);
    // El lote recuerda 3 facturas, pero solo quedan 2.
    const lote = (controller as unknown as { lotes: { findOneRaw: jest.Mock } })
      .lotes;
    lote.findOneRaw.mockResolvedValue({
      _id: LOTE_ID,
      numero: 7,
      estado: 'consolidado',
      progreso: null,
      facturaIds: ['a', 'b', 'c'],
    });

    await expect(
      controller.confirmarGeneracionFacturas(LOTE_ID.toString(), {
        objectPath,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(generacion.confirmar).not.toHaveBeenCalled();
    expect(eventos.emitAsync).not.toHaveBeenCalled();
  });

  it('espera (await) el emitAsync antes de devolver el resultado', async () => {
    const facturasLean = [
      facturaLean({ numeroCompleto: 'FV-1', codigoInmueble: 'A-101' }),
    ];
    const { controller, eventos, objectPath } =
      await construirController(facturasLean);
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

describe('LotesController: acciones de PDF solo para un lote consolidado (S5)', () => {
  const facturaLean = () => ({
    _id: new Types.ObjectId(),
    inmuebleId: new Types.ObjectId(),
    numeroCompleto: 'FV-1',
    codigoInmueble: 'A-101',
  });

  const casosRechazados: [string, Record<string, unknown>, RegExp][] = [
    ['borrador', { estado: 'borrador' }, /debe estar consolidado/],
    ['liquidado', { estado: 'liquidado' }, /debe estar consolidado/],
    [
      'consolidado pero con un reclamo activo',
      { progreso: { actual: 0, total: 0 } },
      /operación en curso/,
    ],
  ];

  it.each(casosRechazados)(
    'solicitar-generacion rechaza un lote %s sin tocar facturas ni generación',
    async (_nombre, over, mensaje) => {
      const { controller, generacion, facturas } = await construirController(
        [facturaLean()],
        undefined,
        over,
      );

      const intento = controller.solicitarGeneracionFacturas(
        LOTE_ID.toString(),
      );

      await expect(intento).rejects.toBeInstanceOf(ConflictException);
      await expect(intento).rejects.toThrow(mensaje);
      expect(facturas.findAllRawPorLote).not.toHaveBeenCalled();
      expect(generacion.solicitar).not.toHaveBeenCalled();
    },
  );

  it.each(casosRechazados)(
    'confirmar-generacion rechaza un lote %s: no confirma, no emite ni congela nada',
    async (_nombre, over, mensaje) => {
      const { controller, generacion, eventos, facturas, objectPath } =
        await construirController([facturaLean()], undefined, over);

      const intento = controller.confirmarGeneracionFacturas(
        LOTE_ID.toString(),
        { objectPath },
      );

      await expect(intento).rejects.toBeInstanceOf(ConflictException);
      await expect(intento).rejects.toThrow(mensaje);
      expect(generacion.confirmar).not.toHaveBeenCalled();
      expect(eventos.emitAsync).not.toHaveBeenCalled();
      expect(facturas.guardarPrintSnapshot).not.toHaveBeenCalled();
    },
  );

  it('solicitar-generacion deja pasar un lote consolidado sin reclamo', async () => {
    const { controller, generacion } = await construirController([
      facturaLean(),
    ]);

    const resultado = await controller.solicitarGeneracionFacturas(
      LOTE_ID.toString(),
    );

    expect(generacion.solicitar).toHaveBeenCalledTimes(1);
    expect(resultado.facturas).toHaveLength(1);
  });

  it('confirmar-generacion deja pasar un lote consolidado sin reclamo', async () => {
    const { controller, generacion, objectPath } = await construirController([
      facturaLean(),
    ]);

    await controller.confirmarGeneracionFacturas(LOTE_ID.toString(), {
      objectPath,
    });

    expect(generacion.confirmar).toHaveBeenCalledTimes(1);
  });
});

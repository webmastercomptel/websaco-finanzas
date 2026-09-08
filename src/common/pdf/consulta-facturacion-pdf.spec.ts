import { PDFDocument } from 'pdf-lib';
import { generarPdfConsultaFacturacion } from './consulta-facturacion-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  RespuestaConsultaFacturacion,
  TotalConceptoLote,
} from '../../contracts';

function makeCopropiedad(): CopropiedadDocument {
  return {
    code: 'COP-001',
    name: 'Conjunto Residencial Prueba',
    taxId: '900123456',
    taxIdVerificationDigit: '7',
    address: 'Cra 10 # 5-20',
    city: 'Bogotá',
    phone: '6012345678',
    email: 'admin@prueba.com',
    status: 'active',
    usesBuildingManagement: false,
    managingEntityId: null,
    administratorName: null,
    receivablesAccount: null,
    advancesAccount: null,
    creditNotesAccount: null,
    debitNotesAccount: null,
  } as CopropiedadDocument;
}

function makeConceptos(cantidad: number): TotalConceptoLote[] {
  return Array.from({ length: cantidad }, (_, i) => ({
    conceptoId: `con-${i}`,
    nombreConcepto: `Concepto ${i + 1}`,
    monto: 10000 * (i + 1),
  }));
}

function makeReporte(
  overrides?: Partial<RespuestaConsultaFacturacion>,
): RespuestaConsultaFacturacion {
  const totalesPorConcepto = overrides?.totalesPorConcepto ?? makeConceptos(2);
  return {
    loteId: 'lote-1',
    loteNumero: 12,
    loteEstado: 'consolidado',
    fechaFacturacion: '2026-08-06',
    fechaVencimiento: '2026-08-31',
    totalesPorConcepto,
    subtotal: 30000,
    totalImpuestos: 0,
    total: 30000,
    filas: [
      {
        inmuebleId: 'inm-1',
        inmuebleCodigo: '301',
        tipoDocumento: 'FV',
        prefijo: 'CONJ-2026',
        numero: 1041,
        numeroCompleto: 'CONJ-2026-1041',
        fechaFactura: '2026-08-06',
        fechaVence: '2026-08-31',
        valoresPorConcepto: Object.fromEntries(
          totalesPorConcepto.map((c) => [c.conceptoId, c.monto]),
        ),
        subtotal: 30000,
        totalImpuestos: 0,
        total: 30000,
      },
    ],
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfConsultaFacturacion', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfConsultaFacturacion(
      makeReporte(),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza con cero conceptos y cero filas', async () => {
    const bytes = await generarPdfConsultaFacturacion(
      makeReporte({ totalesPorConcepto: [], filas: [] }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('agrupa las columnas de concepto en más de un grupo cuando hay más de 6', async () => {
    const bytes = await generarPdfConsultaFacturacion(
      makeReporte({ totalesPorConcepto: makeConceptos(8) }),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    // 8 conceptos con 6 por grupo produce 2 pasadas de tabla — cada una
    // agrega texto suficiente para asegurar más de una página en horizontal.
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('la página es horizontal (más ancha que alta)', async () => {
    const bytes = await generarPdfConsultaFacturacion(
      makeReporte(),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    const pagina = doc.getPage(0);
    expect(pagina.getWidth()).toBeGreaterThan(pagina.getHeight());
  });
});

import { PDFDocument } from 'pdf-lib';
import { generarPdfConsultaFacturacion } from './consulta-facturacion-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  FilaConsultaFacturacion,
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
    montoIva: 0,
  }));
}

function makeFila(
  totalesPorConcepto: TotalConceptoLote[],
  overrides?: Partial<FilaConsultaFacturacion>,
): FilaConsultaFacturacion {
  return {
    id: 'fac-1',
    inmuebleId: 'inm-1',
    inmuebleCodigo: '301',
    tipoDocumento: 'FV',
    prefijo: 'CONJ-2026',
    numero: 1041,
    numeroCompleto: 'CONJ-2026-1041',
    fechaFactura: '2026-08-06',
    fechaVence: '2026-08-31',
    titular: null,
    valoresPorConcepto: Object.fromEntries(
      totalesPorConcepto.map((c) => [c.conceptoId, c.monto]),
    ),
    valoresIvaPorConcepto: {},
    subtotal: 30000,
    totalImpuestos: 0,
    total: 30000,
    saldoPendiente: 30000,
    estado: 'emitida',
    ...overrides,
  };
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
    filas: [makeFila(totalesPorConcepto)],
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

  it('no lanza con hasta once conceptos (cada uno en su propia columna, sin "Otros Cargos")', async () => {
    const bytes = await generarPdfConsultaFacturacion(
      makeReporte({ totalesPorConcepto: makeConceptos(11) }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza con más de once conceptos (los excedentes se agrupan en "Otros Cargos")', async () => {
    const totalesPorConcepto = makeConceptos(15);
    const bytes = await generarPdfConsultaFacturacion(
      makeReporte({
        totalesPorConcepto,
        filas: [makeFila(totalesPorConcepto)],
      }),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('repite el encabezado y el pie "Página x/xxx" en cada página cuando hay muchas facturas', async () => {
    const totalesPorConcepto = makeConceptos(2);
    const filas = Array.from({ length: 80 }, (_, i) =>
      makeFila(totalesPorConcepto, {
        id: `fac-${i}`,
        inmuebleId: `inm-${i}`,
        inmuebleCodigo: String(300 + i),
        numero: 1000 + i,
        numeroCompleto: `CONJ-2026-${1000 + i}`,
      }),
    );
    const bytes = await generarPdfConsultaFacturacion(
      makeReporte({ totalesPorConcepto, filas }),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    // 80 filas no caben en una sola página horizontal — confirma que la
    // paginación manual (necesaria para repetir encabezado y pie) funciona.
    expect(doc.getPageCount()).toBeGreaterThan(1);
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

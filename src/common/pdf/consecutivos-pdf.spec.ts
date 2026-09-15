import { PDFDocument } from 'pdf-lib';
import { generarPdfConsecutivos } from './consecutivos-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  ConceptoColumnaConsecutivos,
  FilaConsecutivo,
  RespuestaConsecutivos,
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
  } as CopropiedadDocument;
}

function makeConceptos(cantidad: number): ConceptoColumnaConsecutivos[] {
  return Array.from({ length: cantidad }, (_, i) => ({
    conceptoId: `con-${i}`,
    nombre: `Concepto ${i + 1}`,
  }));
}

function makeFila(
  conceptos: ConceptoColumnaConsecutivos[],
  overrides?: Partial<FilaConsecutivo>,
): FilaConsecutivo {
  return {
    documentoId: 'doc-1',
    tipoDocumento: 'RC',
    numeroCompleto: 'RC-001-0001',
    inmuebleCodigo: '301',
    fecha: '2026-09-05T00:00:00.000Z',
    valorTotal: 100000,
    cargosPorConcepto: Object.fromEntries(
      conceptos.map((c) => [c.conceptoId, 10000]),
    ),
    ...overrides,
  };
}

function makeReporte(
  overrides?: Partial<RespuestaConsecutivos>,
): RespuestaConsecutivos {
  const conceptos = overrides?.conceptos ?? makeConceptos(2);
  return {
    conceptos,
    filas: [makeFila(conceptos)],
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfConsecutivos', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfConsecutivos(
      makeReporte(),
      makeCopropiedad(),
      'RC',
      '2026-09-01',
      '2026-09-30',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza sin filas ni conceptos', async () => {
    const bytes = await generarPdfConsecutivos(
      makeReporte({ filas: [], conceptos: [] }),
      makeCopropiedad(),
      'RC',
      '2026-09-01',
      '2026-09-30',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza con más de once conceptos (los excedentes se agrupan en "Otros Cargos")', async () => {
    const conceptos = makeConceptos(15);
    const bytes = await generarPdfConsecutivos(
      makeReporte({ conceptos, filas: [makeFila(conceptos)] }),
      makeCopropiedad(),
      'RC',
      '2026-09-01',
      '2026-09-30',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('respeta valores negativos (Nota Contable: origen negativo, destino positivo)', async () => {
    const conceptos = makeConceptos(2);
    const bytes = await generarPdfConsecutivos(
      makeReporte({
        conceptos,
        filas: [
          makeFila(conceptos, {
            tipoDocumento: 'NT',
            cargosPorConcepto: {
              [conceptos[0].conceptoId]: -50000,
              [conceptos[1].conceptoId]: 50000,
            },
          }),
        ],
      }),
      makeCopropiedad(),
      'NT',
      '2026-09-01',
      '2026-09-30',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('la página es horizontal (más ancha que alta)', async () => {
    const bytes = await generarPdfConsecutivos(
      makeReporte(),
      makeCopropiedad(),
      'RC',
      '2026-09-01',
      '2026-09-30',
    );
    const doc = await PDFDocument.load(bytes);
    const pagina = doc.getPage(0);
    expect(pagina.getWidth()).toBeGreaterThan(pagina.getHeight());
  });

  it('un reporte de una sola fila produce exactamente una página, nunca una primera en blanco', async () => {
    const bytes = await generarPdfConsecutivos(
      makeReporte(),
      makeCopropiedad(),
      'RC',
      '2026-09-01',
      '2026-09-30',
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('repite el encabezado y pagina cuando hay muchas filas', async () => {
    const conceptos = makeConceptos(2);
    const filas = Array.from({ length: 120 }, (_, i) =>
      makeFila(conceptos, {
        documentoId: `doc-${i}`,
        numeroCompleto: `RC-001-${i}`,
      }),
    );
    const bytes = await generarPdfConsecutivos(
      makeReporte({ conceptos, filas }),
      makeCopropiedad(),
      'RC',
      '2026-09-01',
      '2026-09-30',
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

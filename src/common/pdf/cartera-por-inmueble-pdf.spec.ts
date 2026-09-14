import { PDFDocument } from 'pdf-lib';
import { generarPdfCarteraPorInmueble } from './cartera-por-inmueble-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  CargoCarteraPorConcepto,
  RespuestaCarteraPorInmueble,
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

function makeConceptos(cantidad: number): CargoCarteraPorConcepto[] {
  return Array.from({ length: cantidad }, (_, i) => ({
    conceptoId: `con-${i}`,
    nombre: `Concepto ${i + 1}`,
    monto: 10000 * (i + 1),
  }));
}

function makeReporte(
  overrides?: Partial<RespuestaCarteraPorInmueble>,
): RespuestaCarteraPorInmueble {
  const cargosPorConcepto = overrides?.cargosPorConcepto ?? makeConceptos(2);
  return {
    inmuebleId: 'inm-1',
    inmuebleCodigo: '301',
    propietario: 'Juan Pérez',
    fechaCorte: '2026-09-14T00:00:00.000Z',
    documentos: [
      {
        documentoId: 'fac-1',
        tipo: 'FV',
        numeroCompleto: 'FV-846',
        fecha: '2026-08-06T00:00:00.000Z',
        vence: '2026-08-31T00:00:00.000Z',
        saldo: 30000,
        cargosPorConcepto: Object.fromEntries(
          cargosPorConcepto.map((c) => [c.conceptoId, c.monto]),
        ),
      },
    ],
    cargosPorConcepto,
    saldoTotalCartera: 30000,
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfCarteraPorInmueble', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfCarteraPorInmueble(
      makeReporte(),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza sin documentos pendientes', async () => {
    const bytes = await generarPdfCarteraPorInmueble(
      makeReporte({ documentos: [], cargosPorConcepto: [] }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza con más de once conceptos (los excedentes se agrupan en "Otros Cargos")', async () => {
    const cargosPorConcepto = makeConceptos(15);
    const bytes = await generarPdfCarteraPorInmueble(
      makeReporte({
        cargosPorConcepto,
        documentos: [
          {
            documentoId: 'fac-1',
            tipo: 'FV',
            numeroCompleto: 'FV-846',
            fecha: '2026-08-06T00:00:00.000Z',
            vence: '2026-08-31T00:00:00.000Z',
            saldo: 30000,
            cargosPorConcepto: Object.fromEntries(
              cargosPorConcepto.map((c) => [c.conceptoId, c.monto]),
            ),
          },
        ],
      }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('la página es horizontal (más ancha que alta)', async () => {
    const bytes = await generarPdfCarteraPorInmueble(
      makeReporte(),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    const pagina = doc.getPage(0);
    expect(pagina.getWidth()).toBeGreaterThan(pagina.getHeight());
  });
});

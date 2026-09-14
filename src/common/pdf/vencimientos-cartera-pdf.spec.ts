import { PDFDocument } from 'pdf-lib';
import { generarPdfVencimientosCartera } from './vencimientos-cartera-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  FilaVencimientoCartera,
  RespuestaVencimientosCartera,
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

function makeFila(
  overrides?: Partial<FilaVencimientoCartera>,
): FilaVencimientoCartera {
  return {
    inmuebleId: 'inm-1',
    inmuebleCodigo: '301',
    propietario: 'Juan Pérez',
    tipo: 'FV',
    numeroCompleto: 'FV-846',
    fecha: '2026-08-06T00:00:00.000Z',
    vence: '2026-08-31T00:00:00.000Z',
    diasMora: 14,
    saldo: 30000,
    rango: 'dias_1_30',
    ...overrides,
  };
}

function makeReporte(
  overrides?: Partial<RespuestaVencimientosCartera>,
): RespuestaVencimientosCartera {
  return {
    fechaCorte: '2026-09-14T00:00:00.000Z',
    filas: [makeFila()],
    rangos: [
      { rango: 'sinVencer', etiqueta: 'Sin Vencer', valor: 0 },
      { rango: 'dias_1_30', etiqueta: '1-30', valor: 30000 },
      { rango: 'dias_31_60', etiqueta: '31-60', valor: 0 },
      { rango: 'dias_61_90', etiqueta: '61-90', valor: 0 },
      { rango: 'dias_91_120', etiqueta: '91-120', valor: 0 },
      { rango: 'dias_121_180', etiqueta: '121-180', valor: 0 },
      { rango: 'dias_181_360', etiqueta: '181-360', valor: 0 },
      { rango: 'dias_361_720', etiqueta: '361-720', valor: 0 },
      { rango: 'dias_720_mas', etiqueta: '+720', valor: 0 },
    ],
    totalCartera: 30000,
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfVencimientosCartera', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfVencimientosCartera(
      makeReporte(),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza sin filas', async () => {
    const bytes = await generarPdfVencimientosCartera(
      makeReporte({ filas: [] }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('la página es horizontal (más ancha que alta)', async () => {
    const bytes = await generarPdfVencimientosCartera(
      makeReporte(),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    const pagina = doc.getPage(0);
    expect(pagina.getWidth()).toBeGreaterThan(pagina.getHeight());
  });

  it('un reporte de una sola fila produce exactamente una página, nunca una primera en blanco', async () => {
    const bytes = await generarPdfVencimientosCartera(
      makeReporte(),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('repite el encabezado y pagina cuando hay muchas filas', async () => {
    const filas = Array.from({ length: 120 }, (_, i) =>
      makeFila({ numeroCompleto: `FV-${i}`, inmuebleCodigo: String(300 + i) }),
    );
    const bytes = await generarPdfVencimientosCartera(
      makeReporte({ filas }),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

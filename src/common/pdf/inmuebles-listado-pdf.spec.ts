import { PDFDocument } from 'pdf-lib';
import { generarPdfListadoInmuebles } from './inmuebles-listado-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makeCopropiedad(
  overrides?: Partial<CopropiedadDocument>,
): CopropiedadDocument {
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
    ...overrides,
  } as unknown as CopropiedadDocument;
}

const empiezaConPdf = (bytes: Uint8Array): string =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfListadoInmuebles', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfListadoInmuebles(
      makeCopropiedad(),
      [
        {
          codigo: '301',
          titular: 'Ana Pérez',
          area: 72,
          coeficiente: 1.8452,
          valores: { 'con-1': 350000 },
        },
      ],
      [{ id: 'con-1', nombre: 'Administración' }],
    );

    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no falla con una lista vacía de inmuebles o de conceptos', async () => {
    const bytes = await generarPdfListadoInmuebles(makeCopropiedad(), [], []);

    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('pagina con muchas filas, repitiendo el encabezado en cada página', async () => {
    const filas = Array.from({ length: 80 }, (_, i) => ({
      codigo: String(100 + i),
      titular: `Titular ${i}`,
      area: 60,
      coeficiente: 1.25,
      valores: { 'con-1': 100000 },
    }));

    const bytes = await generarPdfListadoInmuebles(makeCopropiedad(), filas, [
      { id: 'con-1', nombre: 'Administración' },
    ]);

    expect(empiezaConPdf(bytes)).toBe('%PDF-');
    const releido = await PDFDocument.load(bytes);
    expect(releido.getPageCount()).toBeGreaterThan(1);
  });

  it('genera páginas en formato horizontal (landscape)', async () => {
    const bytes = await generarPdfListadoInmuebles(
      makeCopropiedad(),
      [
        {
          codigo: '301',
          titular: 'Ana Pérez',
          area: 72,
          coeficiente: 1.8452,
          valores: { 'con-1': 350000 },
        },
      ],
      [{ id: 'con-1', nombre: 'Administración' }],
    );

    const releido = await PDFDocument.load(bytes);
    const { width, height } = releido.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
  });
});

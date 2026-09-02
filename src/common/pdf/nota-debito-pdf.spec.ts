import { generarPdfNotaDebito } from './nota-debito-pdf';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makeNotaDebito(
  overrides?: Partial<NotaDebitoDocument>,
): NotaDebitoDocument {
  return {
    _id: { toString: () => 'nd-001' },
    coPropertyId: { toString: () => 'cop-001' },
    inmuebleId: { toString: () => 'inv-001' },
    conceptoId: { toString: () => 'c-001' },
    fullNumber: 'ND-001-0001',
    issueDate: new Date('2026-08-12'),
    total: 50000,
    description: 'Cargo por mora',
    outstandingBalance: 50000,
    status: 'activo',
    ...overrides,
  } as unknown as NotaDebitoDocument;
}

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

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfNotaDebito', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfNotaDebito(
      makeNotaDebito(),
      makeCopropiedad(),
    );

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando description es null', async () => {
    const bytes = await generarPdfNotaDebito(
      makeNotaDebito({ description: null }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando outstandingBalance es 0', async () => {
    const bytes = await generarPdfNotaDebito(
      makeNotaDebito({ outstandingBalance: 0 }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él', async () => {
    const base = await generarPdfNotaDebito(
      makeNotaDebito(),
      makeCopropiedad(),
    );
    const duplicado = await generarPdfNotaDebito(
      makeNotaDebito(),
      makeCopropiedad(),
      { duplicado: true },
    );
    expect(duplicado.length).toBeGreaterThan(base.length);
  });
});

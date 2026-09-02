import { generarPdfNotaContable } from './nota-contable-pdf';
import type { NotaContableDocument } from '../../database/schemas/notas-contables/nota-contable.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makeNotaContable(
  overrides?: Partial<NotaContableDocument>,
): NotaContableDocument {
  return {
    _id: { toString: () => 'nt-001' },
    coPropertyId: { toString: () => 'cop-001' },
    inmuebleId: { toString: () => 'inv-001' },
    fullNumber: 'NT-001-0001',
    createdAt: new Date('2026-08-20'),
    monto: 30000,
    description: 'Reclasificación de intereses',
    conceptoOrigenId: { toString: () => 'c-origen' },
    conceptoDestinoId: { toString: () => 'c-destino' },
    status: 'activo',
    ...overrides,
  } as unknown as NotaContableDocument;
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

describe('generarPdfNotaContable', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfNotaContable(
      makeNotaContable(),
      makeCopropiedad(),
    );

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando createdAt no está presente (cast defensivo)', async () => {
    const nota = makeNotaContable();
    delete (nota as unknown as { createdAt?: Date }).createdAt;
    const bytes = await generarPdfNotaContable(nota, makeCopropiedad());
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él', async () => {
    const base = await generarPdfNotaContable(
      makeNotaContable(),
      makeCopropiedad(),
    );
    const duplicado = await generarPdfNotaContable(
      makeNotaContable(),
      makeCopropiedad(),
      { duplicado: true },
    );
    expect(duplicado.length).toBeGreaterThan(base.length);
  });
});

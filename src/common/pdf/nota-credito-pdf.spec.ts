import { generarPdfNotaCredito } from './nota-credito-pdf';
import type { NotaCreditoDocument } from '../../database/schemas/notas-credito/nota-credito.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makeNotaCredito(
  overrides?: Partial<NotaCreditoDocument>,
): NotaCreditoDocument {
  return {
    _id: { toString: () => 'nc-001' },
    coPropertyId: { toString: () => 'cop-001' },
    inmuebleId: { toString: () => 'inv-001' },
    facturaId: { toString: () => 'fac-001' },
    fullNumber: 'NC-001-0001',
    createdAt: new Date('2026-08-10'),
    totalAmount: 100000,
    reason: 'error_facturacion',
    notes: null,
    appliedAmount: 100000,
    unappliedAmount: 0,
    distribution: [{ conceptoId: { toString: () => 'c-001' }, amount: 100000 }],
    status: 'activo',
    ...overrides,
  } as unknown as NotaCreditoDocument;
}

function makeAplicacion(
  overrides?: Partial<AplicacionCarteraDocument>,
): AplicacionCarteraDocument {
  return {
    sourceType: 'NC',
    documentType: 'FV',
    amountApplied: 100000,
    ...overrides,
  } as unknown as AplicacionCarteraDocument;
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

describe('generarPdfNotaCredito', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfNotaCredito(
      makeNotaCredito(),
      [makeAplicacion()],
      makeCopropiedad(),
    );

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando createdAt no está presente (cast defensivo)', async () => {
    const nota = makeNotaCredito();
    delete (nota as unknown as { createdAt?: Date }).createdAt;
    const bytes = await generarPdfNotaCredito(nota, [], makeCopropiedad());
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando distribution y aplicaciones están vacíos', async () => {
    const bytes = await generarPdfNotaCredito(
      makeNotaCredito({ distribution: [] }),
      [],
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando notes es null', async () => {
    const bytes = await generarPdfNotaCredito(
      makeNotaCredito({ notes: null }),
      [],
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él, sin fecha (NotaCredito no tiene issueDate)', async () => {
    const base = await generarPdfNotaCredito(
      makeNotaCredito(),
      [makeAplicacion()],
      makeCopropiedad(),
    );
    const duplicado = await generarPdfNotaCredito(
      makeNotaCredito(),
      [makeAplicacion()],
      makeCopropiedad(),
      { duplicado: true },
    );
    expect(duplicado.length).toBeGreaterThan(base.length);
  });
});

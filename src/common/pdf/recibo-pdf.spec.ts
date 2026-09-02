import { generarPdfRecibo } from './recibo-pdf';
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makeRecibo(overrides?: Partial<ReciboDocument>): ReciboDocument {
  return {
    _id: { toString: () => 'rec-001' },
    coPropertyId: { toString: () => 'cop-001' },
    inmuebleId: { toString: () => 'inv-001' },
    terceroId: null,
    fullNumber: 'RC-001-0001',
    receivedDate: new Date('2026-08-05'),
    receivedAmount: 300000,
    paymentMethod: 'transferencia',
    destinationAccount: 'Bancolombia 123',
    reference: 'REF-001',
    notes: null,
    appliedAmount: 300000,
    unappliedAmount: 0,
    status: 'activo',
    ...overrides,
  } as unknown as ReciboDocument;
}

function makeAplicacion(
  overrides?: Partial<AplicacionCarteraDocument>,
): AplicacionCarteraDocument {
  return {
    sourceType: 'RC',
    documentType: 'FV',
    amountApplied: 300000,
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

describe('generarPdfRecibo', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfRecibo(
      makeRecibo(),
      [makeAplicacion()],
      makeCopropiedad(),
    );

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando aplicaciones está vacío', async () => {
    const bytes = await generarPdfRecibo(makeRecibo(), [], makeCopropiedad());
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando reference/notes son null', async () => {
    const bytes = await generarPdfRecibo(
      makeRecibo({ reference: null, notes: null }),
      [],
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando unappliedAmount > 0 (anticipo)', async () => {
    const bytes = await generarPdfRecibo(
      makeRecibo({ appliedAmount: 0, unappliedAmount: 300000 }),
      [],
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él', async () => {
    const base = await generarPdfRecibo(
      makeRecibo(),
      [makeAplicacion()],
      makeCopropiedad(),
    );
    const duplicado = await generarPdfRecibo(
      makeRecibo(),
      [makeAplicacion()],
      makeCopropiedad(),
      { duplicado: true },
    );
    expect(duplicado.length).toBeGreaterThan(base.length);
  });
});

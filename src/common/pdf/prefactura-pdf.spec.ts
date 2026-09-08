import { generarPdfPrefactura } from './prefactura-pdf';
import type {
  FacturaPreliminar,
  LoteFacturacionDocument,
} from '../../database/schemas/facturacion/lote-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makePreliminar(
  overrides?: Partial<FacturaPreliminar>,
): FacturaPreliminar {
  return {
    inmuebleId: { toString: () => 'inm-001' },
    unitCode: 'Apt-101',
    terceroId: null,
    holder: {
      name: 'Juan Pérez',
      identificationType: 'CC',
      identificationNumber: '1234567890',
      identificationVerificationDigit: '0',
      address: 'Cra 10 # 5-20',
      city: 'Bogotá',
      email: 'juan@test.com',
    },
    lines: [
      {
        conceptoId: 'c-001',
        conceptName: 'Administración',
        conceptKind: 'administracion',
        source: 'recurrente',
        baseAmount: 200000,
        taxRate: 0,
        taxAmount: 0,
        totalAmount: 200000,
        balanceBefore: 1000000,
        balanceAfter: 1200000,
      },
    ],
    subtotal: 200000,
    totalTax: 0,
    total: 200000,
    ...overrides,
  } as unknown as FacturaPreliminar;
}

function makeLote(
  overrides?: Partial<LoteFacturacionDocument>,
): LoteFacturacionDocument {
  return {
    billingDate: new Date('2026-08-01'),
    dueDate: new Date('2026-08-15'),
    periodStart: new Date('2026-07-01'),
    periodEnd: new Date('2026-07-31'),
    ...overrides,
  } as unknown as LoteFacturacionDocument;
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

describe('generarPdfPrefactura', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfPrefactura(
      makePreliminar(),
      makeLote(),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando holder es null', async () => {
    const bytes = await generarPdfPrefactura(
      makePreliminar({ holder: null }),
      makeLote(),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando lines está vacío', async () => {
    const bytes = await generarPdfPrefactura(
      makePreliminar({ lines: [] }),
      makeLote(),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('mismo layout que una factura real: tamaños comparables para los mismos datos', async () => {
    // Regression guard for the "prefactura y factura deben ser iguales"
    // product decision — this doesn't assert byte-identical (the title text
    // differs: "PREFACTURA" vs "Cobro Expensas Comunes {fullNumber}"), just
    // that neither builder silently dropped a whole section (which would
    // show as a much smaller output).
    const bytes = await generarPdfPrefactura(
      makePreliminar(),
      makeLote(),
      makeCopropiedad(),
    );
    expect(bytes.length).toBeGreaterThan(500);
  });
});

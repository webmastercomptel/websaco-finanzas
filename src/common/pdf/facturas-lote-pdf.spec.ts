import { PDFDocument } from 'pdf-lib';
import { generarPdfFacturasLote } from './facturas-lote-pdf';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makeFactura(overrides?: Partial<FacturaDocument>): FacturaDocument {
  return {
    _id: { toString: () => 'fac-001' },
    coPropertyId: { toString: () => 'cop-001' },
    loteId: { toString: () => 'lote-001' },
    inmuebleId: { toString: () => 'inv-001' },
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
    resolucionId: { toString: () => 'res-001' } as never,
    prefix: 'CONJ-2026',
    number: 1041,
    fullNumber: 'CONJ-2026-1041',
    issueDate: new Date('2026-08-01'),
    dueDate: new Date('2026-08-15'),
    periodStart: new Date('2026-07-01'),
    periodEnd: new Date('2026-07-31'),
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
    outstandingBalance: 200000,
    status: 'emitida',
    voidedByCreditNoteId: null,
    ...overrides,
  } as unknown as FacturaDocument;
}

function makeResolucion(
  overrides?: Partial<ResolucionFacturacionDocument>,
): ResolucionFacturacionDocument {
  return {
    _id: { toString: () => 'res-001' },
    coPropertyId: { toString: () => 'cop-001' },
    resolutionNumber: '12345',
    prefix: 'CONJ-2026',
    rangeFrom: 1,
    rangeTo: 5000,
    nextNumber: 1042,
    validFrom: new Date('2026-01-01'),
    validUntil: null,
    status: 'active',
    ...overrides,
  } as unknown as ResolucionFacturacionDocument;
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

describe('generarPdfFacturasLote', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfFacturasLote(
      [makeFactura()],
      new Map([['res-001', makeResolucion()]]),
      makeCopropiedad(),
    );

    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });

  it('una página por factura — tres facturas, tres páginas', async () => {
    const facturas = [
      makeFactura({
        _id: { toString: () => 'fac-001' } as never,
        unitCode: 'Apt-101',
      }),
      makeFactura({
        _id: { toString: () => 'fac-002' } as never,
        unitCode: 'Apt-102',
      }),
      makeFactura({
        _id: { toString: () => 'fac-003' } as never,
        unitCode: 'Apt-103',
      }),
    ];

    const bytes = await generarPdfFacturasLote(
      facturas,
      new Map([['res-001', makeResolucion()]]),
      makeCopropiedad(),
    );

    const releido = await PDFDocument.load(bytes);
    expect(releido.getPageCount()).toBe(3);
  });

  it('una factura sin resolución (resolucionId null) no rompe el resto del lote', async () => {
    const facturas = [
      makeFactura({ resolucionId: null }),
      makeFactura({ unitCode: 'Apt-102' }),
    ];

    const bytes = await generarPdfFacturasLote(
      facturas,
      new Map([['res-001', makeResolucion()]]),
      makeCopropiedad(),
    );

    const releido = await PDFDocument.load(bytes);
    expect(releido.getPageCount()).toBe(2);
  });

  it('no lanza con un lote vacío', async () => {
    // El controlador nunca llega a llamar esto con una lista vacía (rechaza
    // antes con 404) — esta prueba es solo para que la función en sí no
    // explote si algún día se llama así.
    const bytes = await generarPdfFacturasLote(
      [],
      new Map(),
      makeCopropiedad(),
    );

    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });
});

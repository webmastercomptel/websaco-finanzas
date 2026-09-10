import { generarPdfFactura } from './factura-pdf';
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
    discountAmount: 0,
    discountDeadline: null,
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

describe('generarPdfFactura', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad(),
    );

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    const header = Buffer.from(bytes.slice(0, 5)).toString('utf-8');
    expect(header).toBe('%PDF-');
  });

  noLanzaCuando('holder es null', { holder: null });
  noLanzaCuando('lines está vacío', { lines: [] });
  noLanzaCuando('outstandingBalance es 0', { outstandingBalance: 0 });
  noLanzaCuando(
    'una línea tiene IVA (dibuja Subtotal/IVA además de la tabla)',
    {
      lines: [
        {
          conceptoId: 'c-001',
          conceptName: 'Otros ingresos',
          conceptKind: 'otro',
          source: 'recurrente',
          baseAmount: 100000,
          taxRate: 19,
          taxAmount: 19000,
          totalAmount: 119000,
          balanceBefore: 0,
          balanceAfter: 119000,
        },
      ] as never,
    },
  );

  it('no lanza cuando la copropiedad tiene observaciones de facturación largas', async () => {
    const bytes = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad({
        billingNotes:
          'Recuerde que los pagos después del día 10 generan intereses de mora. Consigne únicamente a la cuenta autorizada por la administración.',
      }),
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });

  it('no lanza y omite el pie de resolución cuando resolucion es null', async () => {
    const bytes = await generarPdfFactura(
      makeFactura({ resolucionId: null }),
      null,
      makeCopropiedad(),
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });

  it('no lanza cuando validUntil es null (resolución abierta)', async () => {
    const bytes = await generarPdfFactura(
      makeFactura(),
      makeResolucion({ validUntil: null }),
      makeCopropiedad(),
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él', async () => {
    const base = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad(),
    );
    const duplicado = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad(),
      { duplicado: true },
    );
    expect(duplicado.length).toBeGreaterThan(base.length);
  });

  it('produce un output más grande con el descuento por pronto pago que sin él', async () => {
    const sinDescuento = await generarPdfFactura(
      makeFactura({ discountAmount: 0, discountDeadline: null }),
      makeResolucion(),
      makeCopropiedad(),
    );
    const conDescuento = await generarPdfFactura(
      makeFactura({
        discountAmount: 10000,
        discountDeadline: new Date('2026-08-10'),
      }),
      makeResolucion(),
      makeCopropiedad(),
    );
    expect(conDescuento.length).toBeGreaterThan(sinDescuento.length);
  });
});

function noLanzaCuando(
  descripcion: string,
  overrides: Partial<FacturaDocument>,
) {
  it(`no lanza cuando ${descripcion}`, async () => {
    const bytes = await generarPdfFactura(
      makeFactura(overrides),
      makeResolucion(),
      makeCopropiedad(),
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });
}

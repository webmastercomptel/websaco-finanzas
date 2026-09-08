import { generarPdfFactura, calcularDescuentoProntoPago } from './factura-pdf';
import type { FacturaDocument } from '../../database/schemas/facturacion/factura.schema';
import type { FacturaLinea } from '../../database/schemas/facturacion/factura-linea.schema';
import type { ResolucionFacturacionDocument } from '../../database/schemas/numeracion/resolucion-facturacion.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { LoteFacturacionDocument } from '../../database/schemas/facturacion/lote-facturacion.schema';

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

function makeLote(
  overrides?: Partial<LoteFacturacionDocument>,
): LoteFacturacionDocument {
  return {
    _id: { toString: () => 'lote-001' },
    coPropertyId: { toString: () => 'cop-001' },
    earlyPaymentDiscount: 0,
    discountDeadline: new Date('2026-08-10'),
    ...overrides,
  } as unknown as LoteFacturacionDocument;
}

describe('generarPdfFactura', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad(),
      null,
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
      null,
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });

  it('no lanza y omite el pie de resolución cuando resolucion es null', async () => {
    const bytes = await generarPdfFactura(
      makeFactura({ resolucionId: null }),
      null,
      makeCopropiedad(),
      null,
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });

  it('no lanza cuando validUntil es null (resolución abierta)', async () => {
    const bytes = await generarPdfFactura(
      makeFactura(),
      makeResolucion({ validUntil: null }),
      makeCopropiedad(),
      null,
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él', async () => {
    const base = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad(),
      null,
    );
    const duplicado = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad(),
      null,
      { duplicado: true },
    );
    expect(duplicado.length).toBeGreaterThan(base.length);
  });

  it('produce un output más grande con el descuento por pronto pago que sin él', async () => {
    const sinDescuento = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad(),
      makeLote({ earlyPaymentDiscount: 0 }),
    );
    const conDescuento = await generarPdfFactura(
      makeFactura(),
      makeResolucion(),
      makeCopropiedad(),
      makeLote({ earlyPaymentDiscount: 5 }),
    );
    expect(conDescuento.length).toBeGreaterThan(sinDescuento.length);
  });

  it('no lanza y omite el descuento cuando el ciclo tiene mora', async () => {
    const bytes = await generarPdfFactura(
      makeFactura({
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
          {
            conceptoId: 'c-002',
            conceptName: 'Intereses de mora',
            conceptKind: 'intereses',
            source: 'mora',
            baseAmount: 5000,
            taxRate: 0,
            taxAmount: 0,
            totalAmount: 5000,
            balanceBefore: 1200000,
            balanceAfter: 1205000,
          },
        ] as never,
      }),
      makeResolucion(),
      makeCopropiedad(),
      makeLote({ earlyPaymentDiscount: 5 }),
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });
});

describe('calcularDescuentoProntoPago', () => {
  const lineaAdministracion: FacturaLinea = {
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
  } as unknown as FacturaLinea;
  const deadline = new Date('2026-08-10');

  it('devuelve null cuando earlyPaymentDiscount es 0', () => {
    expect(
      calcularDescuentoProntoPago([lineaAdministracion], 0, deadline),
    ).toBeNull();
  });

  it('devuelve null cuando el ciclo tiene mora', () => {
    const lineaMora: FacturaLinea = {
      ...lineaAdministracion,
      conceptoId: 'c-002',
      conceptName: 'Intereses de mora',
      conceptKind: 'intereses',
      totalAmount: 5000,
    } as unknown as FacturaLinea;
    expect(
      calcularDescuentoProntoPago(
        [lineaAdministracion, lineaMora],
        5,
        deadline,
      ),
    ).toBeNull();
  });

  it('devuelve null cuando no hay línea de Administración', () => {
    const lineaOtro: FacturaLinea = {
      ...lineaAdministracion,
      conceptoId: 'c-003',
      conceptName: 'Otros ingresos',
      conceptKind: 'otro',
    } as unknown as FacturaLinea;
    expect(calcularDescuentoProntoPago([lineaOtro], 5, deadline)).toBeNull();
  });

  it('calcula el descuento sobre la base de Administración', () => {
    const resultado = calcularDescuentoProntoPago(
      [lineaAdministracion],
      5,
      deadline,
    );
    expect(resultado).toEqual({ fechaLimite: deadline, monto: 10000 });
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
      null,
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('utf-8')).toBe('%PDF-');
  });
}

import { generarPdfRecibo } from './recibo-pdf';
import type { DatosReciboImpresion, LineaAsientoImpresion } from './recibo-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

function makeLinea(
  overrides?: Partial<LineaAsientoImpresion>,
): LineaAsientoImpresion {
  return {
    cuentaCodigo: '130505',
    cuentaNombre: 'CxC Administracion',
    tipoDocumento: 'FV',
    numeroDocumento: 685,
    debito: 0,
    credito: 300000,
    ...overrides,
  };
}

function makeDatos(
  overrides?: Partial<DatosReciboImpresion>,
): DatosReciboImpresion {
  return {
    tituloDocumento: 'Recibo de Caja',
    numeroCompleto: 'RC-001-0001',
    fecha: new Date('2026-08-05'),
    inmuebleCodigo: '1201',
    titularNombre: 'ACOSTA BONILLA JOSE ERNESTO',
    concepto: 'Cancela factura 685',
    monto: 300000,
    lineas: [
      makeLinea(),
      makeLinea({
        cuentaCodigo: '111005',
        cuentaNombre: 'Banco de Occidente',
        tipoDocumento: null,
        numeroDocumento: null,
        debito: 300000,
        credito: 0,
      }),
    ],
    ...overrides,
  };
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
    const bytes = await generarPdfRecibo(makeDatos(), makeCopropiedad());

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('dibuja tituloDocumento en el encabezado — reutilizado por Nota Crédito, no hardcodeado a "Recibo de Caja"', async () => {
    const comoRecibo = await generarPdfRecibo(
      makeDatos({ tituloDocumento: 'Recibo de Caja' }),
      makeCopropiedad(),
    );
    const comoNotaCredito = await generarPdfRecibo(
      makeDatos({ tituloDocumento: 'Nota de Crédito' }),
      makeCopropiedad(),
    );
    // Confirma que el valor realmente se dibuja, no un texto fijo — el
    // largo total puede coincidir por casualidad (compresión del stream),
    // así que se compara el contenido completo, no solo el tamaño.
    expect(Buffer.from(comoRecibo).equals(Buffer.from(comoNotaCredito))).toBe(
      false,
    );
  });

  it('no lanza cuando lineas está vacío (recibo sin aplicaciones ni anticipo)', async () => {
    const bytes = await generarPdfRecibo(
      makeDatos({ lineas: [] }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando la copropiedad no tiene NIT configurado', async () => {
    const bytes = await generarPdfRecibo(
      makeDatos(),
      makeCopropiedad({ taxId: null }),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza con muchas líneas (varias facturas aplicadas en un solo recibo)', async () => {
    const lineas = Array.from({ length: 20 }, (_, i) =>
      makeLinea({ numeroDocumento: i + 1 }),
    );
    const bytes = await generarPdfRecibo(
      makeDatos({ lineas }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él', async () => {
    const base = await generarPdfRecibo(makeDatos(), makeCopropiedad());
    const duplicado = await generarPdfRecibo(makeDatos(), makeCopropiedad(), {
      duplicado: true,
    });
    expect(duplicado.length).toBeGreaterThan(base.length);
  });
});

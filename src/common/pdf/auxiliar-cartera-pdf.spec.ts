import { PDFDocument } from 'pdf-lib';
import { generarPdfAuxiliarCartera } from './auxiliar-cartera-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaAuxiliarCartera } from '../../contracts';

function makeCopropiedad(): CopropiedadDocument {
  return {
    code: 'COP-001',
    name: 'Edificio Terrazas de Granada',
    taxId: '900123456',
    taxIdVerificationDigit: '7',
    address: 'Cra 10 # 5-20',
    city: 'Cali',
    phone: '6012345678',
    email: 'admin@prueba.com',
    status: 'active',
    usesBuildingManagement: false,
    managingEntityId: null,
    administratorName: null,
    receivablesAccount: null,
    advancesAccount: null,
    creditNotesAccount: null,
    debitNotesAccount: null,
  } as CopropiedadDocument;
}

function makeReporte(
  overrides?: Partial<RespuestaAuxiliarCartera>,
): RespuestaAuxiliarCartera {
  return {
    inmuebleId: 'inm-1',
    inmuebleCodigo: '301',
    propietario: 'Juan Perez',
    desde: '2026-08-01T00:00:00.000Z',
    hasta: '2026-08-31T00:00:00.000Z',
    saldoInicial: 500000,
    movimientos: [
      {
        fecha: '2026-08-06T00:00:00.000Z',
        tipo: 'FC',
        numeroCompleto: 'FV-0001',
        concepto: 'Factura de Venta',
        refCruce: null,
        debito: 300000,
        credito: null,
        saldo: 800000,
      },
      {
        fecha: '2026-08-10T00:00:00.000Z',
        tipo: 'RC',
        numeroCompleto: 'RC-0001',
        concepto: 'Recibo RC-0001',
        refCruce: 'FV-0001',
        debito: null,
        credito: 200000,
        saldo: 600000,
      },
    ],
    totalDebitos: 300000,
    totalCreditos: 200000,
    saldoFinal: 600000,
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfAuxiliarCartera', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfAuxiliarCartera(
      makeReporte(),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza con cero movimientos', async () => {
    const bytes = await generarPdfAuxiliarCartera(
      makeReporte({ movimientos: [] }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando propietario es null', async () => {
    const bytes = await generarPdfAuxiliarCartera(
      makeReporte({ propietario: null }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('la página es horizontal (más ancha que alta)', async () => {
    const bytes = await generarPdfAuxiliarCartera(
      makeReporte(),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    const pagina = doc.getPage(0);
    expect(pagina.getWidth()).toBeGreaterThan(pagina.getHeight());
  });

  it('agrega paginas adicionales cuando hay muchos movimientos', async () => {
    const muchosMovimientos = Array.from({ length: 80 }, (_, i) => ({
      fecha: '2026-08-06T00:00:00.000Z',
      tipo: 'FC' as const,
      numeroCompleto: `FV-${i}`,
      concepto: 'Factura de Venta',
      refCruce: null,
      debito: 10000,
      credito: null,
      saldo: 10000 * (i + 1),
    }));

    const bytes = await generarPdfAuxiliarCartera(
      makeReporte({ movimientos: muchosMovimientos }),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

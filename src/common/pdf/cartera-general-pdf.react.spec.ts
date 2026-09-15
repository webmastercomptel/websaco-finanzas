import { generarPdfCarteraGeneralReactPdf } from './cartera-general-pdf.react';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaCarteraGeneral } from '../../contracts';

function makeCopropiedad(): CopropiedadDocument {
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
  } as CopropiedadDocument;
}

function makeReporte(
  overrides?: Partial<RespuestaCarteraGeneral>,
): RespuestaCarteraGeneral {
  return {
    totalCartera: 5000000,
    totalVencido: 1200000,
    totalPendiente: 3800000,
    porcentajeVencido: 24,
    totalCarteraMesAnterior: 4800000,
    diasPromedioMora: 12,
    carteraPorConcepto: [
      { conceptoId: 'con-1', nombre: 'Administración', saldo: 4000000 },
      { conceptoId: 'con-2', nombre: 'Intereses', saldo: 1000000 },
    ],
    tendenciaRecaudo: [
      { anio: 2026, mes: 7, monto: 3000000 },
      { anio: 2026, mes: 8, monto: 3200000 },
    ],
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfCarteraGeneralReactPdf', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfCarteraGeneralReactPdf(
      makeReporte(),
      makeCopropiedad(),
      '2026-09-14',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza sin cartera por concepto ni tendencia de recaudo', async () => {
    const bytes = await generarPdfCarteraGeneralReactPdf(
      makeReporte({ carteraPorConcepto: [], tendenciaRecaudo: [] }),
      makeCopropiedad(),
      '2026-09-14',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando totalCarteraMesAnterior es null', async () => {
    const bytes = await generarPdfCarteraGeneralReactPdf(
      makeReporte({ totalCarteraMesAnterior: null }),
      makeCopropiedad(),
      '2026-09-14',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });
});

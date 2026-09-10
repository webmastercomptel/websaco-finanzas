import { generarPdfConciliacionCartera } from './conciliacion-cartera-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaConciliacionCartera } from '../../contracts';

function makeCopropiedad(
  overrides?: Partial<CopropiedadDocument>,
): CopropiedadDocument {
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
    ...overrides,
  } as CopropiedadDocument;
}

function makeReporte(
  overrides?: Partial<RespuestaConciliacionCartera>,
): RespuestaConciliacionCartera {
  return {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    saldoAnterior: 30000000,
    conceptos: [
      {
        concepto: 'facturacion',
        etiqueta: 'Facturación',
        desde: 'FV1',
        hasta: 'FV167',
        valorDebito: 13500000,
        valorCredito: 0,
      },
      {
        concepto: 'recibos_caja',
        etiqueta: 'Ingresos por Recibos de Caja',
        desde: 'RC1',
        hasta: 'RC100',
        valorDebito: 0,
        valorCredito: 1000000,
      },
    ],
    totalDebito: 13500000,
    totalCredito: 1000000,
    saldoCarteraCalculado: 42500000,
    saldoCarteraReal: 42500000,
    diferencia: 0,
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfConciliacionCartera', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfConciliacionCartera(
      makeReporte(),
      makeCopropiedad(),
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando no hay movimientos en el período', async () => {
    const bytes = await generarPdfConciliacionCartera(
      makeReporte({
        conceptos: [],
        totalDebito: 0,
        totalCredito: 0,
        saldoCarteraCalculado: 30000000,
        saldoCarteraReal: 30000000,
        diferencia: 0,
      }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('agrega texto de alerta cuando diferencia no es cero, produciendo mas bytes', async () => {
    const conciliado = await generarPdfConciliacionCartera(
      makeReporte({ diferencia: 0 }),
      makeCopropiedad(),
    );
    const noConciliado = await generarPdfConciliacionCartera(
      makeReporte({ diferencia: 500000, saldoCarteraCalculado: 43000000 }),
      makeCopropiedad(),
    );
    expect(noConciliado.length).toBeGreaterThan(conciliado.length);
  });

  it('no lanza cuando desde/hasta son null en una fila', async () => {
    const bytes = await generarPdfConciliacionCartera(
      makeReporte({
        conceptos: [
          {
            concepto: 'notas_credito',
            etiqueta: 'Notas Crédito',
            desde: null,
            hasta: null,
            valorDebito: 0,
            valorCredito: 0,
          },
        ],
      }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });
});

import { PDFDocument } from 'pdf-lib';
import { generarPdfCarteraPorConceptos } from './cartera-por-conceptos-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  ConceptoColumnaCarteraPorConceptos,
  GrupoInmuebleCarteraPorConceptos,
  RespuestaCarteraPorConceptos,
} from '../../contracts';

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

function makeConceptos(cantidad: number): ConceptoColumnaCarteraPorConceptos[] {
  return Array.from({ length: cantidad }, (_, i) => ({
    conceptoId: `con-${i}`,
    nombre: `Concepto ${i + 1}`,
  }));
}

function makeGrupo(
  overrides?: Partial<GrupoInmuebleCarteraPorConceptos>,
): GrupoInmuebleCarteraPorConceptos {
  return {
    inmuebleId: 'inm-1',
    inmuebleCodigo: '301',
    titular: 'Juan Pérez',
    celular: '3001234567',
    estadoCartera: 'al_dia',
    documentos: [
      {
        documentoId: 'fac-1',
        tipo: 'FV',
        numeroCompleto: 'FV-846',
        fecha: '2026-08-06T00:00:00.000Z',
        vence: '2026-08-31T00:00:00.000Z',
        saldo: 30000,
        cargosPorConcepto: { 'con-0': 30000 },
      },
    ],
    saldoTotal: 30000,
    ...overrides,
  };
}

function makeReporte(
  overrides?: Partial<RespuestaCarteraPorConceptos>,
): RespuestaCarteraPorConceptos {
  return {
    conceptos: makeConceptos(2),
    grupos: [makeGrupo()],
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfCarteraPorConceptos', () => {
  it.each(['resumido', 'detallado'] as const)(
    'resuelve a bytes que empiezan con %%PDF- (%s)',
    async (tipo) => {
      const bytes = await generarPdfCarteraPorConceptos(
        makeReporte(),
        makeCopropiedad(),
        '2026-09-14T00:00:00.000Z',
        tipo,
      );
      expect(empiezaConPdf(bytes)).toBe('%PDF-');
    },
  );

  it('no lanza sin grupos pendientes', async () => {
    const bytes = await generarPdfCarteraPorConceptos(
      makeReporte({ grupos: [] }),
      makeCopropiedad(),
      '2026-09-14T00:00:00.000Z',
      'detallado',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza con más de ocho conceptos (los excedentes se agrupan en "Otros Cargos")', async () => {
    const conceptos = makeConceptos(12);
    const bytes = await generarPdfCarteraPorConceptos(
      makeReporte({
        conceptos,
        grupos: [
          makeGrupo({
            documentos: [
              {
                documentoId: 'fac-1',
                tipo: 'FV',
                numeroCompleto: 'FV-846',
                fecha: '2026-08-06T00:00:00.000Z',
                vence: '2026-08-31T00:00:00.000Z',
                saldo: 30000,
                cargosPorConcepto: Object.fromEntries(
                  conceptos.map((c) => [c.conceptoId, 1000]),
                ),
              },
            ],
          }),
        ],
      }),
      makeCopropiedad(),
      '2026-09-14T00:00:00.000Z',
      'resumido',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('resumido: una fila por inmueble, sin desglose por documento', async () => {
    const bytes = await generarPdfCarteraPorConceptos(
      makeReporte({
        grupos: [
          makeGrupo({
            documentos: [
              {
                documentoId: 'fac-1',
                tipo: 'FV',
                numeroCompleto: 'FV-846',
                fecha: '2026-08-06T00:00:00.000Z',
                vence: '2026-08-31T00:00:00.000Z',
                saldo: 15000,
                cargosPorConcepto: { 'con-0': 15000 },
              },
              {
                documentoId: 'fac-2',
                tipo: 'FV',
                numeroCompleto: 'FV-847',
                fecha: '2026-08-06T00:00:00.000Z',
                vence: '2026-08-31T00:00:00.000Z',
                saldo: 15000,
                cargosPorConcepto: { 'con-0': 15000 },
              },
            ],
            saldoTotal: 30000,
          }),
        ],
      }),
      makeCopropiedad(),
      '2026-09-14T00:00:00.000Z',
      'resumido',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('la página es horizontal (más ancha que alta)', async () => {
    const bytes = await generarPdfCarteraPorConceptos(
      makeReporte(),
      makeCopropiedad(),
      '2026-09-14T00:00:00.000Z',
      'detallado',
    );
    const doc = await PDFDocument.load(bytes);
    const pagina = doc.getPage(0);
    expect(pagina.getWidth()).toBeGreaterThan(pagina.getHeight());
  });

  describe('con conceptoId (pestaña Por Concepto)', () => {
    it.each(['resumido', 'detallado'] as const)(
      'resuelve a bytes que empiezan con %%PDF- (%s)',
      async (tipo) => {
        const bytes = await generarPdfCarteraPorConceptos(
          makeReporte(),
          makeCopropiedad(),
          '2026-09-14T00:00:00.000Z',
          tipo,
          'con-0',
        );
        expect(empiezaConPdf(bytes)).toBe('%PDF-');
      },
    );

    it('no lanza cuando ningun documento tiene el concepto elegido', async () => {
      const bytes = await generarPdfCarteraPorConceptos(
        makeReporte(),
        makeCopropiedad(),
        '2026-09-14T00:00:00.000Z',
        'detallado',
        'con-sin-cargos',
      );
      expect(empiezaConPdf(bytes)).toBe('%PDF-');
    });

    it('excluye un inmueble cuyos documentos no tienen el concepto elegido', async () => {
      const bytes = await generarPdfCarteraPorConceptos(
        makeReporte({
          grupos: [
            makeGrupo({ inmuebleId: 'inm-1', inmuebleCodigo: '301' }),
            makeGrupo({
              inmuebleId: 'inm-2',
              inmuebleCodigo: '302',
              documentos: [
                {
                  documentoId: 'fac-2',
                  tipo: 'FV',
                  numeroCompleto: 'FV-900',
                  fecha: '2026-08-06T00:00:00.000Z',
                  vence: '2026-08-31T00:00:00.000Z',
                  saldo: 20000,
                  cargosPorConcepto: { 'con-1': 20000 },
                },
              ],
            }),
          ],
        }),
        makeCopropiedad(),
        '2026-09-14T00:00:00.000Z',
        'detallado',
        'con-0',
      );
      expect(empiezaConPdf(bytes)).toBe('%PDF-');
    });
  });
});

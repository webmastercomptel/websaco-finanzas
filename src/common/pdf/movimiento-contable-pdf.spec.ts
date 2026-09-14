import { PDFDocument } from 'pdf-lib';
import { generarPdfMovimientoContable } from './movimiento-contable-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type {
  LineaMovimientoContable,
  MovimientoContable,
  RespuestaMovimientoContable,
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

function makeLinea(
  overrides?: Partial<LineaMovimientoContable>,
): LineaMovimientoContable {
  return {
    cuenta: '413501',
    nombreCuenta: 'Ingresos Administración',
    tipo: 'credito',
    monto: 150000,
    descripcion: 'Administración Agosto',
    tercero: null,
    centroCosto: null,
    flujoCaja: null,
    baseGravable: null,
    documentoCruce: null,
    ...overrides,
  };
}

function makeMovimiento(
  overrides?: Partial<MovimientoContable>,
): MovimientoContable {
  return {
    id: 'mov-1',
    fecha: '2026-08-01T00:00:00.000Z',
    tipoDocumento: 'FC',
    documentoId: 'fv-1',
    numeroDocumento: 'FV-0001',
    inmuebleCodigo: '301',
    propietario: 'Juan Pérez',
    nit: null,
    lineas: [
      makeLinea({ tipo: 'debito', cuenta: '130505', nombreCuenta: 'Cartera' }),
      makeLinea(),
    ],
    totalDebito: 150000,
    totalCredito: 150000,
    cuadra: true,
    ...overrides,
  };
}

function makeReporte(
  overrides?: Partial<RespuestaMovimientoContable>,
): RespuestaMovimientoContable {
  return {
    movimientos: [makeMovimiento()],
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfMovimientoContable', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfMovimientoContable(
      makeReporte(),
      makeCopropiedad(),
      '2026-08-01',
      '2026-08-31',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza sin movimientos', async () => {
    const bytes = await generarPdfMovimientoContable(
      makeReporte({ movimientos: [] }),
      makeCopropiedad(),
      '2026-08-01',
      '2026-08-31',
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('la página es horizontal (más ancha que alta)', async () => {
    const bytes = await generarPdfMovimientoContable(
      makeReporte(),
      makeCopropiedad(),
      '2026-08-01',
      '2026-08-31',
    );
    const doc = await PDFDocument.load(bytes);
    const pagina = doc.getPage(0);
    expect(pagina.getWidth()).toBeGreaterThan(pagina.getHeight());
  });

  it('un reporte chico produce exactamente una página, nunca una primera en blanco', async () => {
    const bytes = await generarPdfMovimientoContable(
      makeReporte(),
      makeCopropiedad(),
      '2026-08-01',
      '2026-08-31',
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it('repite el encabezado y pagina cuando hay muchos movimientos', async () => {
    const movimientos = Array.from({ length: 80 }, (_, i) =>
      makeMovimiento({
        id: `mov-${i}`,
        documentoId: `fv-${i}`,
        numeroDocumento: `FV-${String(i).padStart(4, '0')}`,
      }),
    );
    const bytes = await generarPdfMovimientoContable(
      makeReporte({ movimientos }),
      makeCopropiedad(),
      '2026-08-01',
      '2026-08-31',
    );
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });
});

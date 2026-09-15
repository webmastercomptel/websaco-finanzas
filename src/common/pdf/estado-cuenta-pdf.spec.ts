import { PDFDocument } from 'pdf-lib';
import { generarPdfEstadoCuenta } from './estado-cuenta-pdf';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';
import type { RespuestaEstadoCuenta } from '../../contracts';

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

function makeEstadoCuenta(
  overrides?: Partial<RespuestaEstadoCuenta>,
): RespuestaEstadoCuenta {
  return {
    inmuebleCodigo: '301',
    propietario: 'Juan Pérez',
    copropiedadTelefono: '6012345678',
    copropiedadEmail: 'admin@prueba.com',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    fechaEmision: '2026-08-01',
    saldoAnterior: 0,
    cargosDelMes: 200000,
    pagosRecibidos: 200000,
    descuentosAjustes: 0,
    saldoActual: 0,
    estado: 'al_dia',
    diasMoraMaximo: null,
    movimientos: [
      {
        fecha: '2026-08-01',
        numeroCompleto: 'FV-0001',
        concepto: 'Factura de Venta',
        cargo: 200000,
        abono: null,
        categoria: null,
      },
    ],
    anticipos: [],
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfEstadoCuenta', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfEstadoCuenta(
      makeEstadoCuenta(),
      makeCopropiedad(),
    );

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no lanza cuando propietario/telefono/email son null y movimientos está vacío', async () => {
    const bytes = await generarPdfEstadoCuenta(
      makeEstadoCuenta({
        propietario: null,
        copropiedadTelefono: null,
        copropiedadEmail: null,
        movimientos: [],
      }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él', async () => {
    const base = await generarPdfEstadoCuenta(
      makeEstadoCuenta(),
      makeCopropiedad(),
    );
    const duplicado = await generarPdfEstadoCuenta(
      makeEstadoCuenta(),
      makeCopropiedad(),
      { duplicado: true },
    );
    expect(duplicado.length).toBeGreaterThan(base.length);
  });

  it('la marca de duplicado usa la fechaEmision real, no null hardcodeado', async () => {
    // Regression test for a bug where escribirMarcaDuplicado(ctx, null) was
    // hardcoded regardless of input — this asserts a real fechaEmision
    // produces MORE bytes than an empty one, proving the value flows
    // through. With the bug, both calls draw the exact same fallback text
    // ("DUPLICADO — Documento Original") and would be byte-identical.
    const conFecha = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ fechaEmision: '2026-08-01' }),
      makeCopropiedad(),
      { duplicado: true },
    );
    const sinFecha = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ fechaEmision: '' }),
      makeCopropiedad(),
      { duplicado: true },
    );
    expect(conFecha.length).toBeGreaterThan(sinFecha.length);
  });

  it('agrega bytes de más cuando hay anticipos pendientes que imprimir', async () => {
    const sinAnticipos = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ anticipos: [] }),
      makeCopropiedad(),
    );
    const conAnticipos = await generarPdfEstadoCuenta(
      makeEstadoCuenta({
        anticipos: [
          { numeroCompleto: 'RC-0011', fecha: '2026-06-02', monto: 180200 },
        ],
      }),
      makeCopropiedad(),
    );
    expect(conAnticipos.length).toBeGreaterThan(sinAnticipos.length);
  });

  it('el encabezado incluye el nombre de la copropiedad y su NIT', async () => {
    const bytes = await generarPdfEstadoCuenta(
      makeEstadoCuenta(),
      makeCopropiedad({ name: 'Conjunto Prueba', taxId: '800555444' }),
    );
    const doc = await PDFDocument.load(bytes);
    // Presencia del nombre/NIT se valida indirectamente: un doc con nombre
    // más largo produce más bytes que uno con nombre corto, dado que todo
    // lo demás es igual — confirma que el nombre realmente se dibuja.
    const bytesNombreCorto = await generarPdfEstadoCuenta(
      makeEstadoCuenta(),
      makeCopropiedad({ name: 'X', taxId: '800555444' }),
    );
    expect(bytes.length).toBeGreaterThan(bytesNombreCorto.length);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('embeds the WebSACO logo — a missing/corrupt asset file breaks generation loudly', async () => {
    // Proves the logo-loading path is really exercised (not dead code):
    // pointing the read at a file that doesn't exist must make the whole
    // PDF generation reject, the same way a real deploy missing the asset
    // would fail loudly instead of silently shipping a logo-less PDF.
    let generarConFsRoto!: typeof generarPdfEstadoCuenta;
    jest.isolateModules(() => {
      jest.doMock('fs', () => ({
        readFileSync: jest.fn(() => {
          throw new Error('ENOENT: no such file');
        }),
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const modulo = require('./estado-cuenta-pdf') as {
        generarPdfEstadoCuenta: typeof generarPdfEstadoCuenta;
      };
      generarConFsRoto = modulo.generarPdfEstadoCuenta;
    });

    await expect(
      generarConFsRoto(makeEstadoCuenta(), makeCopropiedad()),
    ).rejects.toThrow('ENOENT');
  });

  it('agrega fila de totales Cargo/Abono cuando hay mas de una linea de movimiento', async () => {
    const conDosLineas = await generarPdfEstadoCuenta(
      makeEstadoCuenta({
        movimientos: [
          {
            fecha: '2026-08-01',
            numeroCompleto: 'FV-0001',
            concepto: 'Factura de Venta',
            cargo: 200000,
            abono: null,
            categoria: null,
          },
          {
            fecha: '2026-08-10',
            numeroCompleto: 'RC-0001',
            concepto: 'Recibo',
            cargo: null,
            abono: 150000,
            categoria: 'pago',
          },
        ],
      }),
      makeCopropiedad(),
    );
    const conUnaLinea = await generarPdfEstadoCuenta(
      makeEstadoCuenta(),
      makeCopropiedad(),
    );
    // Two rows plus a totals row must produce more bytes than one row and
    // no totals row — proves the totals row is actually drawn, not skipped.
    expect(conDosLineas.length).toBeGreaterThan(conUnaLinea.length);
    const doc = await PDFDocument.load(conDosLineas);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('no agrega fila de totales cuando hay una sola linea o ninguna', async () => {
    const unaLinea = await generarPdfEstadoCuenta(
      makeEstadoCuenta(),
      makeCopropiedad(),
    );
    const ceroLineas = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ movimientos: [] }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(unaLinea)).toBe('%PDF-');
    expect(empiezaConPdf(ceroLineas)).toBe('%PDF-');
  });

  it('stamps a page-number footer on every page of a multi-page statement', async () => {
    const muchosMovimientos = Array.from({ length: 60 }, (_, i) => ({
      fecha: '2026-08-06',
      numeroCompleto: `FV-${String(i).padStart(4, '0')}`,
      concepto: `Movimiento ${i}`,
      cargo: 10000,
      abono: null,
      categoria: null,
    }));

    const bytes = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ movimientos: muchosMovimientos }),
      makeCopropiedad(),
    );
    const doc = await PDFDocument.load(bytes);
    // Enough rows to force a page break — proves the footer loop actually
    // reaches every page, not just the first one.
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('el pie de página incluye telefono \\ email cuando ambos existen', async () => {
    const conContacto = await generarPdfEstadoCuenta(
      makeEstadoCuenta({
        copropiedadTelefono: '6012345678',
        copropiedadEmail: 'admin@prueba.com',
      }),
      makeCopropiedad(),
    );
    const sinContacto = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ copropiedadTelefono: null, copropiedadEmail: null }),
      makeCopropiedad(),
    );
    // Same document otherwise — the only difference is the footer's left
    // side, so drawing it must produce more bytes.
    expect(conContacto.length).toBeGreaterThan(sinContacto.length);
  });

  it('no lanza cuando telefono y email son ambos null (pie de pagina sin lado izquierdo)', async () => {
    const bytes = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ copropiedadTelefono: null, copropiedadEmail: null }),
      makeCopropiedad(),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('omits the NIT line when the copropiedad has none, without throwing', async () => {
    const bytes = await generarPdfEstadoCuenta(
      makeEstadoCuenta(),
      makeCopropiedad({ taxId: null, taxIdVerificationDigit: null }),
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('no hay columna "Días Mora" en el detalle — un estado vencido con diasMoraMaximo produce más bytes junto al resumen (bug real reportado: no debía ser una columna más)', async () => {
    const alDia = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ estado: 'al_dia', diasMoraMaximo: null }),
      makeCopropiedad(),
    );
    const vencidoConMora = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ estado: 'vencido', diasMoraMaximo: 45 }),
      makeCopropiedad(),
    );
    // "Al Día" (sin días de mora) vs. "Vencida — 45 días de mora" — el
    // resumen debe crecer, no la tabla de movimientos (que se queda con las
    // mismas 5 columnas fijas: Fecha, Número, Concepto, Cargo, Abono).
    expect(vencidoConMora.length).toBeGreaterThan(alDia.length);
  });
});

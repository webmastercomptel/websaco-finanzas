import { generarPdfEstadoCuenta } from './estado-cuenta-pdf';
import type { RespuestaEstadoCuenta } from '../../contracts';

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
    vencimiento: '2026-08-15',
    saldoAnterior: 0,
    cargosDelMes: 200000,
    pagosRecibidos: 200000,
    descuentosAjustes: 0,
    saldoActual: 0,
    estado: 'al_dia',
    movimientos: [
      {
        fecha: '2026-08-01',
        concepto: 'Factura de Venta',
        cargo: 200000,
        abono: null,
        categoria: null,
      },
    ],
    ...overrides,
  };
}

const empiezaConPdf = (bytes: Uint8Array) =>
  Buffer.from(bytes.slice(0, 5)).toString('utf-8');

describe('generarPdfEstadoCuenta', () => {
  it('resuelve a bytes que empiezan con %PDF-', async () => {
    const bytes = await generarPdfEstadoCuenta(makeEstadoCuenta());

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
    );
    expect(empiezaConPdf(bytes)).toBe('%PDF-');
  });

  it('produce un output más grande con duplicado que sin él', async () => {
    const base = await generarPdfEstadoCuenta(makeEstadoCuenta());
    const duplicado = await generarPdfEstadoCuenta(makeEstadoCuenta(), {
      duplicado: true,
    });
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
      { duplicado: true },
    );
    const sinFecha = await generarPdfEstadoCuenta(
      makeEstadoCuenta({ fechaEmision: '' }),
      { duplicado: true },
    );
    expect(conFecha.length).toBeGreaterThan(sinFecha.length);
  });
});

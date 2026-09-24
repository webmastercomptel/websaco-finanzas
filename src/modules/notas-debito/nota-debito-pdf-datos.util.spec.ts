import { Types } from 'mongoose';
import { construirDatosImpresionNotaDebito } from './nota-debito-pdf-datos.util';
import type { NotaDebitoDocument } from '../../database/schemas/notas-debito/nota-debito.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const CONCEPTO = new Types.ObjectId();

const notaBase = (over: Record<string, unknown> = {}): NotaDebitoDocument =>
  ({
    _id: new Types.ObjectId(),
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    conceptoId: CONCEPTO,
    fullNumber: 'ND-0002',
    issueDate: new Date('2026-08-12'),
    total: 50000,
    description: null,
    ...over,
  }) as unknown as NotaDebitoDocument;

const copropiedadBase = (): CopropiedadDocument =>
  ({
    name: 'Conjunto Residencial Los Alamos',
    taxId: '900123456',
    taxIdVerificationDigit: '7',
    showLogoOnDocuments: true,
    receivablesAccount: '130500',
  }) as unknown as CopropiedadDocument;

const modelosCon = (
  over: {
    inmuebles?: Record<string, unknown>;
    terceros?: Record<string, unknown>;
    conceptos?: Record<string, unknown>;
    asientos?: Record<string, unknown>;
    cuentasContables?: Record<string, unknown>;
  } = {},
) => ({
  inmuebles: over.inmuebles ?? {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve({ code: '301' }) })),
  },
  terceros: over.terceros ?? {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve({ name: 'JUAN PEREZ' }),
    })),
  },
  conceptos: over.conceptos ?? {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve({ name: 'Multas' }),
    })),
  },
  asientos: over.asientos ?? {
    findOne: jest.fn(() => ({
      exec: () =>
        Promise.resolve({
          entries: [
            { account: '130510', type: 'debito', amount: 50000 },
            { account: '413505', type: 'credito', amount: 50000 },
          ],
        }),
    })),
  },
  cuentasContables: over.cuentasContables ?? {
    find: jest.fn(() => ({
      exec: () =>
        Promise.resolve([
          { code: '130510', name: 'CxC Multas' },
          { code: '413505', name: 'Ingresos por Multas' },
        ]),
    })),
  },
});

describe('construirDatosImpresionNotaDebito', () => {
  it('arma el encabezado a partir del inmueble, el titular y usa "Nota de Débito" como tituloDocumento', async () => {
    const datos = await construirDatosImpresionNotaDebito(
      notaBase(),
      copropiedadBase(),
      COP,
      modelosCon() as never,
      'Nota de Débito',
    );

    expect(datos.tituloDocumento).toBe('Nota de Débito');
    expect(datos.numeroCompleto).toBe('ND-0002');
    expect(datos.inmuebleCodigo).toBe('301');
    expect(datos.titularNombre).toBe('JUAN PEREZ');
    expect(datos.fecha).toEqual(new Date('2026-08-12'));
    expect(datos.monto).toBe(50000);
  });

  it('arma emisor/logoFilas desde la copropiedad y suma débito/crédito de las líneas', async () => {
    const datos = await construirDatosImpresionNotaDebito(
      notaBase(),
      copropiedadBase(),
      COP,
      modelosCon() as never,
      'Nota de Débito',
    );

    expect(datos.emisor.nombre).toBe('Conjunto Residencial Los Alamos');
    expect(datos.emisor.nitCompleto).toBe('900123456-7');
    expect(datos.logoFilas).toEqual([{}]);
    expect(datos.totalDebito).toBe(
      datos.lineas.reduce((acc, l) => acc + l.debito, 0),
    );
    expect(datos.totalCredito).toBe(
      datos.lineas.reduce((acc, l) => acc + l.credito, 0),
    );
  });

  it('usa description cuando la nota la tiene', async () => {
    const datos = await construirDatosImpresionNotaDebito(
      notaBase({ description: 'Multa por mascota sin correa' }),
      copropiedadBase(),
      COP,
      modelosCon() as never,
      'Nota de Débito',
    );

    expect(datos.concepto).toBe('Multa por mascota sin correa');
  });

  it('cae al nombre del concepto cuando la nota no tiene description propia', async () => {
    const datos = await construirDatosImpresionNotaDebito(
      notaBase({ description: null }),
      copropiedadBase(),
      COP,
      modelosCon() as never,
      'Nota de Débito',
    );

    expect(datos.concepto).toBe('Multas');
  });

  it('arma las líneas del asiento tal como quedaron posteadas (débito/crédito, cuenta y nombre resueltos)', async () => {
    const datos = await construirDatosImpresionNotaDebito(
      notaBase(),
      copropiedadBase(),
      COP,
      modelosCon() as never,
      'Nota de Débito',
    );

    expect(datos.lineas).toEqual([
      {
        cuentaCodigo: '130510',
        cuentaNombre: 'CxC Multas',
        tipoDocumento: null,
        numeroDocumento: null,
        debito: 50000,
        credito: 0,
      },
      {
        cuentaCodigo: '413505',
        cuentaNombre: 'Ingresos por Multas',
        tipoDocumento: null,
        numeroDocumento: null,
        debito: 0,
        credito: 50000,
      },
    ]);
  });

  it('sin ningún asiento encontrado, no lanza y devuelve una tabla vacía', async () => {
    const datos = await construirDatosImpresionNotaDebito(
      notaBase(),
      copropiedadBase(),
      COP,
      modelosCon({
        asientos: {
          findOne: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
        },
      }) as never,
      'Nota de Débito',
    );

    expect(datos.lineas).toEqual([]);
  });
});

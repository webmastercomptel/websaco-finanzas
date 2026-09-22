import { Types } from 'mongoose';
import { construirDatosImpresionNotaAnticipo } from './nota-anticipo-pdf-datos.util';
import type { NotaAnticipoDocument } from '../../database/schemas/notas-anticipo/nota-anticipo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const RECIBO_ORIGEN = new Types.ObjectId();
const FACTURA = new Types.ObjectId();

const notaBase = (over: Record<string, unknown> = {}): NotaAnticipoDocument =>
  ({
    _id: new Types.ObjectId(),
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    reciboOrigenId: RECIBO_ORIGEN,
    fullNumber: 'NA-0003',
    issueDate: new Date('2026-07-12'),
    appliedAmount: 200000,
    ...over,
  }) as unknown as NotaAnticipoDocument;

const copropiedadBase = (
  over: Record<string, unknown> = {},
): CopropiedadDocument =>
  ({
    receivablesAccount: '130500',
    advancesAccount: '210505',
    ...over,
  }) as unknown as CopropiedadDocument;

const aplicacionFV = (
  over: Record<string, unknown> = {},
): AplicacionCarteraDocument =>
  ({
    documentType: 'FV',
    documentId: FACTURA,
    amountApplied: 200000,
    detalleConceptos: [],
    ...over,
  }) as unknown as AplicacionCarteraDocument;

const modelosVacios = () => ({
  facturas: { find: jest.fn(() => ({ exec: () => Promise.resolve([]) })) },
  notasDebito: { find: jest.fn(() => ({ exec: () => Promise.resolve([]) })) },
  recibos: {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve({ fullNumber: 'RC-0009' }),
    })),
  },
  inmuebles: {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve({ code: '1105' }) })),
  },
  terceros: {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve({ name: 'MARIA GOMEZ' }),
    })),
  },
  cuentasContables: {
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  },
});

describe('construirDatosImpresionNotaAnticipo', () => {
  it('arma el encabezado a partir del inmueble, el titular y usa "Nota de Anticipo" como tituloDocumento', async () => {
    const datos = await construirDatosImpresionNotaAnticipo(
      notaBase(),
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Anticipo',
    );

    expect(datos.tituloDocumento).toBe('Nota de Anticipo');
    expect(datos.numeroCompleto).toBe('NA-0003');
    expect(datos.inmuebleCodigo).toBe('1105');
    expect(datos.titularNombre).toBe('MARIA GOMEZ');
    expect(datos.fecha).toEqual(new Date('2026-07-12'));
    expect(datos.monto).toBe(200000);
  });

  it('el concepto nombra el recibo de origen', async () => {
    const datos = await construirDatosImpresionNotaAnticipo(
      notaBase(),
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Anticipo',
    );

    expect(datos.concepto).toBe('Aplicación de anticipo — recibo RC-0009');
  });

  it('el débito es SIEMPRE una sola línea a cuentaAnticipos por el total aplicado — nunca partido, nunca una cuenta de banco', async () => {
    const datos = await construirDatosImpresionNotaAnticipo(
      notaBase({ appliedAmount: 200000 }),
      [aplicacionFV({ amountApplied: 200000 })],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Anticipo',
    );

    const filasDebito = datos.lineas.filter((l) => l.debito > 0);
    expect(filasDebito).toEqual([
      expect.objectContaining({
        cuentaCodigo: '210505',
        debito: 200000,
        tipoDocumento: null,
      }),
    ]);
  });

  it('una línea de crédito por cada concepto de detalleConceptos, resolviendo la cuenta propia del concepto en la Factura', async () => {
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const modelos = modelosVacios();
    modelos.facturas.find = jest.fn(() => ({
      exec: () =>
        Promise.resolve([
          {
            _id: FACTURA,
            number: 685,
            lines: [
              {
                conceptoId: conceptoAdmin,
                accountingReceivableAccount: '13050501',
              },
              {
                conceptoId: conceptoMora,
                accountingReceivableAccount: '13050502',
              },
            ],
          },
        ]),
    })) as never;
    modelos.cuentasContables.find = jest.fn(() => ({
      exec: () =>
        Promise.resolve([
          { code: '13050501', name: 'CxC Administracion' },
          { code: '13050502', name: 'CxC Intereses de Mora' },
          { code: '210505', name: 'Anticipos de Clientes' },
        ]),
    })) as never;

    const aplicacion = aplicacionFV({
      amountApplied: 130000,
      detalleConceptos: [
        {
          conceptoId: conceptoAdmin,
          conceptName: 'Administracion',
          monto: 100000,
        },
        {
          conceptoId: conceptoMora,
          conceptName: 'Intereses de Mora',
          monto: 30000,
        },
      ],
    });

    const datos = await construirDatosImpresionNotaAnticipo(
      notaBase({ appliedAmount: 130000 }),
      [aplicacion],
      copropiedadBase(),
      COP,
      modelos as never,
      'Nota de Anticipo',
    );

    expect(datos.lineas).toEqual([
      {
        cuentaCodigo: '210505',
        cuentaNombre: 'Anticipos de Clientes',
        tipoDocumento: null,
        numeroDocumento: null,
        debito: 130000,
        credito: 0,
      },
      {
        cuentaCodigo: '13050501',
        cuentaNombre: 'CxC Administracion',
        tipoDocumento: 'FV',
        numeroDocumento: 685,
        debito: 0,
        credito: 100000,
      },
      {
        cuentaCodigo: '13050502',
        cuentaNombre: 'CxC Intereses de Mora',
        tipoDocumento: 'FV',
        numeroDocumento: 685,
        debito: 0,
        credito: 30000,
      },
    ]);
  });

  it('una Nota Débito aplicada siempre credita la cartera compartida de la copropiedad, sin cuenta propia', async () => {
    const notaId = new Types.ObjectId();
    const modelos = modelosVacios();
    modelos.notasDebito.find = jest.fn(() => ({
      exec: () => Promise.resolve([{ _id: notaId, number: 12 }]),
    })) as never;

    const aplicacion = {
      documentType: 'ND',
      documentId: notaId,
      amountApplied: 150000,
      detalleConceptos: [
        {
          conceptoId: new Types.ObjectId(),
          conceptName: 'Cuota Parqueadero',
          monto: 150000,
        },
      ],
    } as unknown as AplicacionCarteraDocument;

    const datos = await construirDatosImpresionNotaAnticipo(
      notaBase({ appliedAmount: 150000 }),
      [aplicacion],
      copropiedadBase(),
      COP,
      modelos as never,
      'Nota de Anticipo',
    );

    const filaCredito = datos.lineas.find((l) => l.tipoDocumento === 'ND');
    expect(filaCredito).toMatchObject({
      cuentaCodigo: '130500',
      numeroDocumento: 12,
      credito: 150000,
    });
  });

  it('cae en una sola fila genérica cuando detalleConceptos está vacío (aplicación anterior a ese campo)', async () => {
    const aplicacion = aplicacionFV({
      amountApplied: 200000,
      detalleConceptos: [],
    });
    const datos = await construirDatosImpresionNotaAnticipo(
      notaBase({ appliedAmount: 200000 }),
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Anticipo',
    );

    const filaAplicacion = datos.lineas.find((l) => l.tipoDocumento === 'FV');
    expect(filaAplicacion).toMatchObject({
      cuentaCodigo: '130500',
      credito: 200000,
    });
  });

  it('sin terceroId, no consulta terceros y muestra "—"', async () => {
    const modelos = modelosVacios();
    const datos = await construirDatosImpresionNotaAnticipo(
      notaBase({ terceroId: null }),
      [],
      copropiedadBase(),
      COP,
      modelos as never,
      'Nota de Anticipo',
    );

    expect(modelos.terceros.findOne).not.toHaveBeenCalled();
    expect(datos.titularNombre).toBe('—');
  });
});

import { Types } from 'mongoose';
import { construirDatosImpresionNotaCredito } from './nota-credito-pdf-datos.util';
import type { NotaCreditoDocument } from '../../database/schemas/notas-credito/nota-credito.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const FACTURA = new Types.ObjectId();
const CONCEPTO = new Types.ObjectId();

const notaBase = (over: Record<string, unknown> = {}): NotaCreditoDocument =>
  ({
    _id: new Types.ObjectId(),
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    facturaId: FACTURA,
    fullNumber: 'NC-0002',
    issueDate: new Date('2026-06-10'),
    reason: 'error_facturacion',
    notes: null,
    totalAmount: 100000,
    unappliedAmount: 0,
    distribution: [{ conceptoId: CONCEPTO, amount: 100000 }],
    ...over,
  }) as unknown as NotaCreditoDocument;

const copropiedadBase = (
  over: Record<string, unknown> = {},
): CopropiedadDocument =>
  ({
    receivablesAccount: '130500',
    advancesAccount: '210505',
    creditNotesAccount: '413595',
    ...over,
  }) as unknown as CopropiedadDocument;

const aplicacionFV = (
  over: Record<string, unknown> = {},
): AplicacionCarteraDocument =>
  ({
    documentType: 'FV',
    documentId: FACTURA,
    amountApplied: 100000,
    detalleConceptos: [],
    ...over,
  }) as unknown as AplicacionCarteraDocument;

const modelosVacios = () => ({
  facturas: { find: jest.fn(() => ({ exec: () => Promise.resolve([]) })) },
  inmuebles: {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve({ code: '1304' }) })),
  },
  terceros: {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve({ name: 'JUAN PEREZ' }),
    })),
  },
  cuentasContables: {
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  },
});

describe('construirDatosImpresionNotaCredito', () => {
  it('arma el encabezado a partir del inmueble, el titular y usa "Nota de Crédito" como tituloDocumento', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase(),
      0,
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    expect(datos.tituloDocumento).toBe('Nota de Crédito');
    expect(datos.numeroCompleto).toBe('NC-0002');
    expect(datos.inmuebleCodigo).toBe('1304');
    expect(datos.titularNombre).toBe('JUAN PEREZ');
    expect(datos.fecha).toEqual(new Date('2026-06-10'));
    expect(datos.monto).toBe(100000);
  });

  it('usa la etiqueta del motivo cuando la nota no tiene notes', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ notes: null, reason: 'descuento_comercial' }),
      0,
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    expect(datos.concepto).toBe('Descuento comercial');
  });

  it('usa notes cuando la nota sí las tiene, en vez del motivo', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ notes: 'Cancela factura 685' }),
      0,
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    expect(datos.concepto).toBe('Cancela factura 685');
  });

  it('una línea por cada concepto de detalleConceptos, resolviendo la cuenta propia del concepto en la Factura', async () => {
    const conceptoAdmin = new Types.ObjectId();
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
            ],
          },
        ]),
    })) as never;
    modelos.cuentasContables.find = jest.fn(() => ({
      exec: () =>
        Promise.resolve([
          { code: '13050501', name: 'CxC Administracion' },
          { code: '413595', name: 'Devoluciones en Ventas' },
        ]),
    })) as never;

    const aplicacion = aplicacionFV({
      detalleConceptos: [
        {
          conceptoId: conceptoAdmin,
          conceptName: 'Administracion',
          monto: 100000,
        },
      ],
    });

    const datos = await construirDatosImpresionNotaCredito(
      notaBase(),
      0,
      [aplicacion],
      copropiedadBase(),
      COP,
      modelos as never,
    );

    expect(datos.lineas).toEqual([
      {
        cuentaCodigo: '13050501',
        cuentaNombre: 'CxC Administracion',
        tipoDocumento: 'FV',
        numeroDocumento: 685,
        debito: 0,
        credito: 100000,
      },
      {
        cuentaCodigo: '413595',
        cuentaNombre: 'Devoluciones en Ventas',
        tipoDocumento: null,
        numeroDocumento: null,
        debito: 100000,
        credito: 0,
      },
    ]);
  });

  it('cae en una sola fila genérica cuando detalleConceptos está vacío (aplicación anterior a ese campo)', async () => {
    const aplicacion = aplicacionFV({
      amountApplied: 100000,
      detalleConceptos: [],
    });
    const datos = await construirDatosImpresionNotaCredito(
      notaBase(),
      0,
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    const filaAplicacion = datos.lineas.find((l) => l.tipoDocumento === 'FV');
    expect(filaAplicacion).toMatchObject({
      cuentaCodigo: '130500',
      credito: 100000,
    });
  });

  it('agrega una línea de anticipo cuando la nota dejó valor sin aplicar', async () => {
    const aplicacion = aplicacionFV({ amountApplied: 60000 });
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ totalAmount: 100000, unappliedAmount: 40000 }),
      40000,
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    const filaAnticipo = datos.lineas.find((l) => l.cuentaCodigo === '210505');
    expect(filaAnticipo).toMatchObject({ credito: 40000, tipoDocumento: null });
  });

  it('no agrega línea de anticipo cuando la nota se aplicó por completo', async () => {
    const aplicacion = aplicacionFV({ amountApplied: 100000 });
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ totalAmount: 100000, unappliedAmount: 0 }),
      0,
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    expect(datos.lineas.some((l) => l.cuentaCodigo === '210505')).toBe(false);
  });

  it('cae a cuentaDevoluciones cuando el concepto no tiene accountingIncomeAccount configurado (nunca una cuenta de banco)', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ totalAmount: 100000 }),
      0,
      [],
      copropiedadBase({ creditNotesAccount: '413595' }),
      COP,
      modelosVacios() as never,
    );

    const filaDebito = datos.lineas.find((l) => l.debito > 0);
    expect(filaDebito).toMatchObject({
      cuentaCodigo: '413595',
      debito: 100000,
    });
  });

  it('el débito se reparte por concepto según nota.distribution, tomando accountingIncomeAccount de la factura ancla — nunca una sola cuenta de devoluciones para todo', async () => {
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
              { conceptoId: conceptoAdmin, accountingIncomeAccount: '413501' },
              { conceptoId: conceptoMora, accountingIncomeAccount: '413502' },
            ],
          },
        ]),
    })) as never;

    const datos = await construirDatosImpresionNotaCredito(
      notaBase({
        totalAmount: 130000,
        distribution: [
          { conceptoId: conceptoAdmin, amount: 100000 },
          { conceptoId: conceptoMora, amount: 30000 },
        ],
      }),
      0,
      [],
      copropiedadBase(),
      COP,
      modelos as never,
    );

    const filasDebito = datos.lineas.filter((l) => l.debito > 0);
    expect(filasDebito).toEqual([
      expect.objectContaining({ cuentaCodigo: '413501', debito: 100000 }),
      expect.objectContaining({ cuentaCodigo: '413502', debito: 30000 }),
    ]);
  });

  it('cae a createdAt cuando issueDate es null (nota creada antes de este campo)', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({
        issueDate: null,
        createdAt: new Date('2026-05-01'),
      }),
      0,
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    expect(datos.fecha).toEqual(new Date('2026-05-01'));
  });
});

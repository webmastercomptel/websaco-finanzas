import { Types } from 'mongoose';
import { construirDatosImpresionRecibo } from './recibo-pdf-datos.util';
import type { ReciboDocument } from '../../database/schemas/recibos/recibo.schema';
import type { AplicacionCarteraDocument } from '../../database/schemas/recibos/aplicacion-cartera.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const TERCERO = new Types.ObjectId();

const reciboBase = (over: Record<string, unknown> = {}): ReciboDocument =>
  ({
    _id: new Types.ObjectId(),
    inmuebleId: INMUEBLE,
    terceroId: TERCERO,
    fullNumber: 'RC-0005',
    receivedDate: new Date('2026-08-06'),
    receivedAmount: 905040,
    destinationAccount: '11100502',
    notes: 'Cancela factura 685',
    ...over,
  }) as unknown as ReciboDocument;

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
    documentId: new Types.ObjectId(),
    amountApplied: 453000,
    detalleConceptos: [],
    ...over,
  }) as unknown as AplicacionCarteraDocument;

const modelosVacios = () => ({
  facturas: { find: jest.fn(() => ({ exec: () => Promise.resolve([]) })) },
  notasDebito: { find: jest.fn(() => ({ exec: () => Promise.resolve([]) })) },
  inmuebles: {
    findOne: jest.fn(() => ({ exec: () => Promise.resolve({ code: '1201' }) })),
  },
  terceros: {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve({ name: 'ACOSTA BONILLA JOSE ERNESTO' }),
    })),
  },
  cuentasContables: {
    find: jest.fn(() => ({ exec: () => Promise.resolve([]) })),
  },
});

describe('construirDatosImpresionRecibo', () => {
  it('arma el encabezado a partir del inmueble, el titular y las notes del recibo', async () => {
    const datos = await construirDatosImpresionRecibo(
      reciboBase(),
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    expect(datos.numeroCompleto).toBe('RC-0005');
    expect(datos.inmuebleCodigo).toBe('1201');
    expect(datos.titularNombre).toBe('ACOSTA BONILLA JOSE ERNESTO');
    expect(datos.concepto).toBe('Cancela factura 685');
    expect(datos.monto).toBe(905040);
  });

  it('usa "Pago recibido" cuando el recibo no tiene notes', async () => {
    const datos = await construirDatosImpresionRecibo(
      reciboBase({ notes: null }),
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    expect(datos.concepto).toBe('Pago recibido');
  });

  it('una línea por cada concepto de detalleConceptos, resolviendo la cuenta propia del concepto en la Factura', async () => {
    const facturaId = new Types.ObjectId();
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const modelos = modelosVacios();
    modelos.facturas.find = jest.fn(() => ({
      exec: () =>
        Promise.resolve([
          {
            _id: facturaId,
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
          { code: '11100502', name: 'Banco de Occidente' },
        ]),
    })) as never;

    const aplicacion = aplicacionFV({
      documentId: facturaId,
      amountApplied: 520000,
      detalleConceptos: [
        {
          conceptoId: conceptoAdmin,
          conceptName: 'Administracion',
          monto: 453000,
        },
        {
          conceptoId: conceptoMora,
          conceptName: 'Intereses de Mora',
          monto: 67000,
        },
      ],
    });

    const datos = await construirDatosImpresionRecibo(
      reciboBase({ receivedAmount: 520000 }),
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
        credito: 453000,
      },
      {
        cuentaCodigo: '13050502',
        cuentaNombre: 'CxC Intereses de Mora',
        tipoDocumento: 'FV',
        numeroDocumento: 685,
        debito: 0,
        credito: 67000,
      },
      {
        cuentaCodigo: '11100502',
        cuentaNombre: 'Banco de Occidente',
        tipoDocumento: null,
        numeroDocumento: null,
        debito: 520000,
        credito: 0,
      },
    ]);
  });

  it('agrega una línea de anticipo cuando el recibo dejó dinero sin aplicar en su propia creación', async () => {
    const aplicacion = aplicacionFV({ amountApplied: 300000 });
    const datos = await construirDatosImpresionRecibo(
      reciboBase({ receivedAmount: 500000 }),
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    const filaAnticipo = datos.lineas.find((l) => l.cuentaCodigo === '210505');
    expect(filaAnticipo).toMatchObject({
      credito: 200000,
      tipoDocumento: null,
    });
  });

  it('el anticipo se calcula sobre lo que ESTE recibo aplicó, no sobre unappliedAmount (una Nota de Anticipo posterior no debe reescribir este print)', async () => {
    // El recibo original aplicó 300000 de 500000 → 200000 de anticipo. Si
    // después una Nota de Anticipo consumió parte de ese saldo,
    // `unappliedAmount` en la base de datos ya bajó — pero el propio recibo
    // debe seguir imprimiendo lo que ÉL posteó, no el saldo vivo.
    const aplicacion = aplicacionFV({ amountApplied: 300000 });
    const datos = await construirDatosImpresionRecibo(
      reciboBase({ receivedAmount: 500000, unappliedAmount: 50000 }),
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    const filaAnticipo = datos.lineas.find((l) => l.cuentaCodigo === '210505');
    expect(filaAnticipo?.credito).toBe(200000);
  });

  it('el anticipo descuenta el efectivo, no lo bruto aplicado — el descuento por pronto pago debe sumarse al anticipo, no restarlo', async () => {
    // Recibo de 1.000.000, factura con saldo de 1.000.000 y 50.000 de
    // descuento por pronto pago: la factura queda cancelada (amountApplied
    // 1.000.000 bruto, discountApplied 50.000), pero el efectivo real usado
    // fue solo 950.000 (1.000.000 - 50.000 de descuento) — el resto
    // (50.000) es anticipo, no dinero que "desapareció" en la factura.
    const aplicacion = aplicacionFV({
      amountApplied: 1000000,
      discountApplied: 50000,
    });
    const datos = await construirDatosImpresionRecibo(
      reciboBase({ receivedAmount: 1000000 }),
      [aplicacion],
      copropiedadBase({ discountsDebitAccount: '530525' }),
      COP,
      modelosVacios() as never,
    );

    const filaAnticipo = datos.lineas.find((l) => l.cuentaCodigo === '210505');
    expect(filaAnticipo?.credito).toBe(50000);

    const filaDescuento = datos.lineas.find((l) => l.cuentaCodigo === '530525');
    expect(filaDescuento).toMatchObject({ debito: 50000, credito: 0 });

    const totalDebito = datos.lineas.reduce((acc, l) => acc + l.debito, 0);
    const totalCredito = datos.lineas.reduce((acc, l) => acc + l.credito, 0);
    expect(totalDebito).toBe(totalCredito);
  });

  it('con otherIncomeAmount > 0, credita Otros Ingresos en vez de Anticipos', async () => {
    // Mismo recibo que el primer caso de anticipo (500000 recibidos, 300000
    // aplicados, 200000 de sobrante) pero con ese sobrante confirmado como
    // Otros Ingresos (`destinoSobrante: 'otros_ingresos'`) — la línea debe
    // salir en SU cuenta (429505), nunca en Anticipos (210505), el bug
    // reportado en vivo (screenshot: salió en 28050501 "Anticipos").
    const aplicacion = aplicacionFV({ amountApplied: 300000 });
    const datos = await construirDatosImpresionRecibo(
      reciboBase({ receivedAmount: 500000, otherIncomeAmount: 200000 }),
      [aplicacion],
      copropiedadBase({ otherIncomeCreditAccount: '429505' }),
      COP,
      modelosVacios() as never,
    );

    expect(datos.lineas.some((l) => l.cuentaCodigo === '210505')).toBe(false);
    const filaOtrosIngresos = datos.lineas.find(
      (l) => l.cuentaCodigo === '429505',
    );
    expect(filaOtrosIngresos).toMatchObject({
      credito: 200000,
      tipoDocumento: null,
    });
  });

  it('no agrega línea de anticipo cuando el recibo se aplicó por completo', async () => {
    const aplicacion = aplicacionFV({ amountApplied: 500000 });
    const datos = await construirDatosImpresionRecibo(
      reciboBase({ receivedAmount: 500000 }),
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    expect(datos.lineas.some((l) => l.cuentaCodigo === '210505')).toBe(false);
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

    const datos = await construirDatosImpresionRecibo(
      reciboBase({ receivedAmount: 150000 }),
      [aplicacion],
      copropiedadBase(),
      COP,
      modelos as never,
    );

    expect(datos.lineas[0]).toMatchObject({
      cuentaCodigo: '130500',
      tipoDocumento: 'ND',
      numeroDocumento: 12,
      credito: 150000,
    });
  });

  it('cae en una sola fila genérica cuando detalleConceptos está vacío (aplicaciones anteriores a ese campo)', async () => {
    const aplicacion = aplicacionFV({
      amountApplied: 400000,
      detalleConceptos: [],
    });
    const datos = await construirDatosImpresionRecibo(
      reciboBase({ receivedAmount: 400000 }),
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
    );

    const filaAplicacion = datos.lineas.find((l) => l.tipoDocumento === 'FV');
    expect(filaAplicacion).toMatchObject({
      cuentaCodigo: '130500',
      credito: 400000,
    });
  });
});

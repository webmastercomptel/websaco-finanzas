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
    numeroCompleto: 'NC-0002',
    fecha: new Date('2026-06-10'),
    motivo: 'ajuste_precio',
    observaciones: null,
    montoTotal: 100000,
    distribucion: [{ conceptoId: CONCEPTO, monto: 100000 }],
    ...over,
  }) as unknown as NotaCreditoDocument;

const copropiedadBase = (
  over: Record<string, unknown> = {},
): CopropiedadDocument =>
  ({
    nombre: 'Conjunto Residencial Los Alamos',
    nit: '900123456',
    digitoVerificacion: '7',
    mostrarLogo: true,
    cuentaContableCartera: '130500',
    cuentaAnticipos: '210505',
    cuentaDevoluciones: '413595',
    ...over,
  }) as unknown as CopropiedadDocument;

const aplicacionFV = (
  over: Record<string, unknown> = {},
): AplicacionCarteraDocument =>
  ({
    tipoDocumento: 'FV',
    documentoId: FACTURA,
    montoAplicado: 100000,
    detalleConceptos: [],
    ...over,
  }) as unknown as AplicacionCarteraDocument;

const modelosVacios = () => ({
  facturas: { find: jest.fn(() => ({ exec: () => Promise.resolve([]) })) },
  inmuebles: {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve({ codigo: '1304' }),
    })),
  },
  terceros: {
    findOne: jest.fn(() => ({
      exec: () => Promise.resolve({ nombre: 'JUAN PEREZ' }),
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
      'Nota de Crédito',
    );

    expect(datos.tituloDocumento).toBe('Nota de Crédito');
    expect(datos.numeroCompleto).toBe('NC-0002');
    expect(datos.inmuebleCodigo).toBe('1304');
    expect(datos.titularNombre).toBe('JUAN PEREZ');
    expect(datos.fecha).toEqual(new Date('2026-06-10'));
    expect(datos.monto).toBe(100000);
  });

  it('arma emisor/logoFilas desde la copropiedad y suma débito/crédito de las líneas', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase(),
      0,
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Crédito',
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

  it('usa la etiqueta del motivo cuando la nota no tiene notes', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ observaciones: null, motivo: 'descuento' }),
      0,
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Crédito',
    );

    expect(datos.concepto).toBe('Rebaja o descuento parcial o total');
  });

  it('usa notes cuando la nota sí las tiene, en vez del motivo', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ observaciones: 'Cancela factura 685' }),
      0,
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Crédito',
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
            numero: 685,
            lineas: [
              {
                conceptoId: conceptoAdmin,
                cuentaCartera: '13050501',
              },
            ],
          },
        ]),
    })) as never;
    modelos.cuentasContables.find = jest.fn(() => ({
      exec: () =>
        Promise.resolve([
          { codigo: '13050501', nombre: 'CxC Administracion' },
          { codigo: '413595', nombre: 'Devoluciones en Ventas' },
        ]),
    })) as never;

    const aplicacion = aplicacionFV({
      detalleConceptos: [
        {
          conceptoId: conceptoAdmin,
          nombreConcepto: 'Administracion',
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
      'Nota de Crédito',
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

  it('con ancla Saldo Inicial, credita la cuentaCartera de cada fila y muestra el documento original (FV / 2941), nunca SI ni el número interno', async () => {
    const SI_ID = new Types.ObjectId();
    const C1 = new Types.ObjectId();
    const C2 = new Types.ObjectId();
    const modelos = {
      ...modelosVacios(),
      saldosIniciales: {
        find: jest.fn(() => ({
          exec: () =>
            Promise.resolve([
              {
                _id: SI_ID,
                numero: 2,
                tipoDocumentoOriginal: 'FV',
                numeroOriginal: '2941',
                filas: [
                  {
                    conceptoId: C1,
                    tipoConcepto: 'administracion',
                    cuentaCartera: '13050501',
                    cuentaIngreso: null,
                  },
                  {
                    conceptoId: C2,
                    tipoConcepto: 'intereses',
                    cuentaCartera: '13050503',
                    cuentaIngreso: '42100501',
                  },
                ],
              },
            ]),
        })),
      },
    };
    const aplicacion = {
      tipoDocumento: 'SI',
      documentoId: SI_ID,
      montoAplicado: 100000,
      detalleConceptos: [
        { conceptoId: C1, nombreConcepto: 'Administración', monto: 60000 },
        { conceptoId: C2, nombreConcepto: 'Intereses', monto: 40000 },
      ],
    } as unknown as AplicacionCarteraDocument;

    const datos = await construirDatosImpresionNotaCredito(
      notaBase({
        tipoDocumentoAncla: 'SI',
        facturaId: null,
        saldoInicialId: SI_ID,
        distribucion: [{ conceptoId: C1, monto: 100000 }],
      }),
      0,
      [aplicacion],
      copropiedadBase({ usaCuentasOrden: true }),
      COP,
      modelos as never,
      'Nota de Crédito',
    );

    const creditos = datos.lineas.filter((l) => l.credito > 0);
    expect(creditos).toEqual([
      expect.objectContaining({
        cuentaCodigo: '13050501',
        tipoDocumento: 'FV',
        numeroDocumento: '2941',
        credito: 60000,
      }),
      // intereses + usaCuentasOrden → cuentaIngreso, same rule as the real
      // posting (cuentaCarteraDeLinea)
      expect.objectContaining({
        cuentaCodigo: '42100501',
        tipoDocumento: 'FV',
        numeroDocumento: '2941',
        credito: 40000,
      }),
    ]);
  });

  it('cae en una sola fila genérica cuando detalleConceptos está vacío (aplicación anterior a ese campo)', async () => {
    const aplicacion = aplicacionFV({
      montoAplicado: 100000,
      detalleConceptos: [],
    });
    const datos = await construirDatosImpresionNotaCredito(
      notaBase(),
      0,
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Crédito',
    );

    const filaAplicacion = datos.lineas.find((l) => l.tipoDocumento === 'FV');
    expect(filaAplicacion).toMatchObject({
      cuentaCodigo: '130500',
      credito: 100000,
    });
  });

  it('agrega una línea de anticipo cuando la nota dejó valor sin aplicar', async () => {
    const aplicacion = aplicacionFV({ montoAplicado: 60000 });
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ montoTotal: 100000 }),
      40000,
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Crédito',
    );

    const filaAnticipo = datos.lineas.find((l) => l.cuentaCodigo === '210505');
    expect(filaAnticipo).toMatchObject({ credito: 40000, tipoDocumento: null });
  });

  it('no agrega línea de anticipo cuando la nota se aplicó por completo', async () => {
    const aplicacion = aplicacionFV({ montoAplicado: 100000 });
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ montoTotal: 100000 }),
      0,
      [aplicacion],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Crédito',
    );

    expect(datos.lineas.some((l) => l.cuentaCodigo === '210505')).toBe(false);
  });

  it('cae a cuentaDevoluciones cuando el concepto no tiene cuentaIngreso configurado (nunca una cuenta de banco)', async () => {
    const datos = await construirDatosImpresionNotaCredito(
      notaBase({ montoTotal: 100000 }),
      0,
      [],
      copropiedadBase({ cuentaDevoluciones: '413595' }),
      COP,
      modelosVacios() as never,
      'Nota de Crédito',
    );

    const filaDebito = datos.lineas.find((l) => l.debito > 0);
    expect(filaDebito).toMatchObject({
      cuentaCodigo: '413595',
      debito: 100000,
    });
  });

  it('el débito se reparte por concepto según nota.distribution, tomando cuentaIngreso de la factura ancla — nunca una sola cuenta de devoluciones para todo', async () => {
    const conceptoAdmin = new Types.ObjectId();
    const conceptoMora = new Types.ObjectId();
    const modelos = modelosVacios();
    modelos.facturas.find = jest.fn(() => ({
      exec: () =>
        Promise.resolve([
          {
            _id: FACTURA,
            numero: 685,
            lineas: [
              { conceptoId: conceptoAdmin, cuentaIngreso: '413501' },
              { conceptoId: conceptoMora, cuentaIngreso: '413502' },
            ],
          },
        ]),
    })) as never;

    const datos = await construirDatosImpresionNotaCredito(
      notaBase({
        montoTotal: 130000,
        distribucion: [
          { conceptoId: conceptoAdmin, monto: 100000 },
          { conceptoId: conceptoMora, monto: 30000 },
        ],
      }),
      0,
      [],
      copropiedadBase(),
      COP,
      modelos as never,
      'Nota de Crédito',
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
        fecha: null,
        createdAt: new Date('2026-05-01'),
      }),
      0,
      [],
      copropiedadBase(),
      COP,
      modelosVacios() as never,
      'Nota de Crédito',
    );

    expect(datos.fecha).toEqual(new Date('2026-05-01'));
  });
});

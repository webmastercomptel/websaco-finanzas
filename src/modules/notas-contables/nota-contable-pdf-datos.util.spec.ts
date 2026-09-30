import { Types } from 'mongoose';
import { construirDatosImpresionNotaContable } from './nota-contable-pdf-datos.util';
import type { NotaContableDocument } from '../../database/schemas/notas-contables/nota-contable.schema';
import type { CopropiedadDocument } from '../../database/schemas/copropiedades/copropiedad.schema';

const COP = new Types.ObjectId();
const INMUEBLE = new Types.ObjectId();
const HOLDER = new Types.ObjectId();
const CONCEPTO_ORIGEN = new Types.ObjectId();
const CONCEPTO_DESTINO = new Types.ObjectId();

const notaBase = (over: Record<string, unknown> = {}): NotaContableDocument =>
  ({
    _id: new Types.ObjectId(),
    inmuebleId: INMUEBLE,
    conceptoOrigenId: CONCEPTO_ORIGEN,
    conceptoDestinoId: CONCEPTO_DESTINO,
    monto: 100000,
    description: 'Reclasificación de TV a Pintura',
    fullNumber: 'NT-0003',
    issueDate: new Date('2026-08-15'),
    ...over,
  }) as unknown as NotaContableDocument;

const copropiedadBase = (
  over: Record<string, unknown> = {},
): CopropiedadDocument =>
  ({
    nombre: 'Conjunto Residencial Los Alamos',
    nit: '900123456',
    digitoVerificacion: '7',
    mostrarLogo: true,
    ...over,
  }) as unknown as CopropiedadDocument;

const modelos = (
  over: {
    origenCuenta?: string | null;
    destinoCuenta?: string | null;
    inmueble?: Record<string, unknown> | null;
    tercero?: Record<string, unknown> | null;
    cuentas?: Record<string, unknown>[];
  } = {},
) => ({
  conceptos: {
    findOne: jest.fn((filtro: { _id: Types.ObjectId }) => ({
      populate: jest.fn().mockReturnThis(),
      exec: () => {
        if (filtro._id.equals(CONCEPTO_ORIGEN)) {
          return Promise.resolve(
            over.origenCuenta === null
              ? { cuentaCreditoId: null }
              : { cuentaCreditoId: { codigo: over.origenCuenta ?? '413501' } },
          );
        }
        return Promise.resolve(
          over.destinoCuenta === null
            ? { cuentaCreditoId: null }
            : { cuentaCreditoId: { codigo: over.destinoCuenta ?? '413502' } },
        );
      },
    })),
  },
  inmuebles: {
    findOne: jest.fn(() => ({
      exec: () =>
        Promise.resolve(
          'inmueble' in over
            ? over.inmueble
            : { codigo: '301', titularId: HOLDER },
        ),
    })),
  },
  terceros: {
    findOne: jest.fn(() => ({
      exec: () =>
        Promise.resolve(
          'tercero' in over ? over.tercero : { nombre: 'Carlos Mendoza' },
        ),
    })),
  },
  cuentasContables: {
    find: jest.fn(() => ({
      exec: () => Promise.resolve(over.cuentas ?? []),
    })),
  },
});

describe('construirDatosImpresionNotaContable', () => {
  it('usa "Nota Contable" como tituloDocumento y el description de la nota como concepto', async () => {
    const datos = await construirDatosImpresionNotaContable(
      notaBase(),
      copropiedadBase(),
      COP,
      modelos() as never,
      'Nota Contable',
    );

    expect(datos.tituloDocumento).toBe('Nota Contable');
    expect(datos.numeroCompleto).toBe('NT-0003');
    expect(datos.concepto).toBe('Reclasificación de TV a Pintura');
    expect(datos.monto).toBe(100000);
  });

  it('arma emisor/logoFilas desde la copropiedad y suma débito/crédito de las líneas', async () => {
    const datos = await construirDatosImpresionNotaContable(
      notaBase(),
      copropiedadBase(),
      COP,
      modelos() as never,
      'Nota Contable',
    );

    expect(datos.emisor.nombre).toBe('Conjunto Residencial Los Alamos');
    expect(datos.emisor.nitCompleto).toBe('900123456-7');
    expect(datos.logoFilas).toEqual([{}]);
    expect(datos.totalDebito).toBe(100000);
    expect(datos.totalCredito).toBe(100000);
  });

  it('resuelve inmuebleCodigo y titularNombre vía Inmueble.titularId -> Tercero.nombre', async () => {
    const datos = await construirDatosImpresionNotaContable(
      notaBase(),
      copropiedadBase(),
      COP,
      modelos() as never,
      'Nota Contable',
    );

    expect(datos.inmuebleCodigo).toBe('301');
    expect(datos.titularNombre).toBe('Carlos Mendoza');
  });

  it('sin titularId, titularNombre queda en "—" sin consultar Terceros', async () => {
    const m = modelos({ inmueble: { codigo: '301', titularId: null } });
    const datos = await construirDatosImpresionNotaContable(
      notaBase(),
      copropiedadBase(),
      COP,
      m as never,
      'Nota Contable',
    );

    expect(datos.titularNombre).toBe('—');
    expect(m.terceros.findOne).not.toHaveBeenCalled();
  });

  it('acredita la cuenta ORIGEN y debita la cuenta DESTINO — vista de cartera, igual que el asiento real', async () => {
    const datos = await construirDatosImpresionNotaContable(
      notaBase(),
      copropiedadBase(),
      COP,
      modelos({ origenCuenta: '413501', destinoCuenta: '413502' }) as never,
      'Nota Contable',
    );

    expect(datos.lineas).toEqual([
      expect.objectContaining({
        cuentaCodigo: '413501',
        debito: 0,
        credito: 100000,
      }),
      expect.objectContaining({
        cuentaCodigo: '413502',
        debito: 100000,
        credito: 0,
      }),
    ]);
  });

  it('resuelve el nombre de cada cuenta contable, con fallback al código cuando no está en el catálogo', async () => {
    const datos = await construirDatosImpresionNotaContable(
      notaBase(),
      copropiedadBase(),
      COP,
      modelos({
        origenCuenta: '413501',
        destinoCuenta: '413502',
        cuentas: [{ codigo: '413501', nombre: 'Ingresos TV' }],
      }) as never,
      'Nota Contable',
    );

    expect(datos.lineas[0].cuentaNombre).toBe('Ingresos TV');
    expect(datos.lineas[1].cuentaNombre).toBe('413502');
  });

  it('sin cuentaCreditoId configurada, cae a la cuenta de reserva', async () => {
    const datos = await construirDatosImpresionNotaContable(
      notaBase(),
      copropiedadBase(),
      COP,
      modelos({ origenCuenta: null, destinoCuenta: '413502' }) as never,
      'Nota Contable',
    );

    expect(datos.lineas[0].cuentaCodigo).toBe('SIN-CUENTA-ASIGNADA');
  });
});

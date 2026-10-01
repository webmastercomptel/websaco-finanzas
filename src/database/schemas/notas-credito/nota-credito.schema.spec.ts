import mongoose, { Types } from 'mongoose';
import { NotaCreditoSchema } from './nota-credito.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  NotaCreditoSchema.indexes() as unknown as IndiceDeclarado[];

const NotaCreditoModel = mongoose.model('NotaCreditoSpec', NotaCreditoSchema);

const copropiedad = new Types.ObjectId();
const inmueble = new Types.ObjectId();
const tercero = new Types.ObjectId();
const factura = new Types.ObjectId();
const notaDebito = new Types.ObjectId();
const concepto = new Types.ObjectId();
const cuenta = new Types.ObjectId();

const base = (over: Record<string, unknown> = {}) => ({
  copropiedadId: copropiedad,
  inmuebleId: inmueble,
  terceroId: tercero,
  facturaId: factura,
  numeroCompleto: 'NC-1',
  motivo: 'ajuste_precio',
  montoTotal: 200000,
  distribucion: [{ conceptoId: concepto, monto: 200000 }],
  montoSinAplicar: 200000,
  generadoPor: cuenta,
  ...over,
});

const validar = async (
  campos: Record<string, unknown>,
): Promise<Error | null> => {
  const doc = new NotaCreditoModel(base(campos));
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
};

describe('NotaCreditoSchema — forma', () => {
  it('acepta una nota crédito bien formada', async () => {
    await expect(validar({})).resolves.toBeNull();
  });

  it('acepta terceroId null — la factura ancla puede no tener Tercero vinculado', async () => {
    await expect(validar({ terceroId: null })).resolves.toBeNull();
  });

  it('acepta un ancla en Nota Débito — facturaId null, notaDebitoId seteado', async () => {
    await expect(
      validar({
        facturaId: null,
        notaDebitoId: notaDebito,
        tipoDocumentoAncla: 'ND',
      }),
    ).resolves.toBeNull();
  });

  it('tipoDocumentoAncla arranca null — solo una nota creada antes de este campo lo deja así (ancla siempre FV en ese caso)', () => {
    const doc = new NotaCreditoModel(base());
    expect(doc.tipoDocumentoAncla).toBeNull();
    expect(doc.notaDebitoId).toBeNull();
  });

  it('arranca activo, con montoAplicado en cero y sin datos de anulación', () => {
    const doc = new NotaCreditoModel(base());
    expect(doc.estado).toBe('activo');
    expect(doc.montoAplicado).toBe(0);
    expect(doc.motivoAnulacion).toBeNull();
    expect(doc.detalleAnulacion).toBeNull();
    expect(doc.fechaAnulacion).toBeNull();
  });

  it('fecha arranca null — solo una nota creada antes de este campo lo deja así', () => {
    const doc = new NotaCreditoModel(base());
    expect(doc.fecha).toBeNull();
  });

  it('acepta fecha — la fecha que el usuario declaró al crearla', async () => {
    const fecha = new Date('2026-08-15');
    const doc = new NotaCreditoModel(base({ fecha }));
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(doc.fecha).toEqual(fecha);
  });

  it('rechaza un motivo fuera del catálogo', async () => {
    await expect(validar({ motivo: 'porque_si' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('rechaza un estado fuera de activo/anulado', async () => {
    await expect(validar({ estado: 'pendiente' })).resolves.toBeInstanceOf(
      Error,
    );
  });
});

describe('NotaCreditoSchema — índices', () => {
  it('el número completo es único por copropiedad', () => {
    const indice = indices().find(
      ([campos]) => campos.copropiedadId === 1 && campos.numeroCompleto === 1,
    );
    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({ unique: true });
  });

  it('indexa copropiedad + inmueble + saldo sin aplicar, para el listado con anticipo disponible', () => {
    const indice = indices().find(
      ([campos]) =>
        campos.copropiedadId === 1 &&
        campos.inmuebleId === 1 &&
        campos.montoSinAplicar === 1,
    );
    expect(indice).toBeDefined();
  });
});

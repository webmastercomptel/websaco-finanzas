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
const concepto = new Types.ObjectId();
const cuenta = new Types.ObjectId();

const base = (over: Record<string, unknown> = {}) => ({
  coPropertyId: copropiedad,
  inmuebleId: inmueble,
  terceroId: tercero,
  facturaId: factura,
  fullNumber: 'NC-1',
  reason: 'error_facturacion',
  totalAmount: 200000,
  distribution: [{ conceptoId: concepto, amount: 200000 }],
  unappliedAmount: 200000,
  generatedBy: cuenta,
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

  it('exige facturaId, a diferencia de un Recibo', async () => {
    const error = await validar({ facturaId: undefined });
    expect(error?.message).toContain('facturaId');
  });

  it('arranca activo, con appliedAmount en cero y sin datos de anulación', () => {
    const doc = new NotaCreditoModel(base());
    expect(doc.status).toBe('activo');
    expect(doc.appliedAmount).toBe(0);
    expect(doc.voidedReason).toBeNull();
    expect(doc.voidedDetail).toBeNull();
    expect(doc.voidedAt).toBeNull();
  });

  it('rechaza un motivo fuera del catálogo', async () => {
    await expect(validar({ reason: 'porque_si' })).resolves.toBeInstanceOf(Error);
  });

  it('rechaza un estado fuera de activo/anulado', async () => {
    await expect(validar({ status: 'pendiente' })).resolves.toBeInstanceOf(Error);
  });
});

describe('NotaCreditoSchema — índices', () => {
  it('el número completo es único por copropiedad', () => {
    const indice = indices().find(
      ([campos]) => campos.coPropertyId === 1 && campos.fullNumber === 1,
    );
    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({ unique: true });
  });

  it('indexa copropiedad + inmueble + saldo sin aplicar, para el listado con anticipo disponible', () => {
    const indice = indices().find(
      ([campos]) =>
        campos.coPropertyId === 1 &&
        campos.inmuebleId === 1 &&
        campos.unappliedAmount === 1,
    );
    expect(indice).toBeDefined();
  });
});

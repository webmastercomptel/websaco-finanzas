import mongoose, { Types } from 'mongoose';
import { NotaDebitoSchema } from './nota-debito.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  NotaDebitoSchema.indexes() as unknown as IndiceDeclarado[];

const NotaDebitoModel = mongoose.model('NotaDebitoSpec', NotaDebitoSchema);

const copropiedad = new Types.ObjectId();
const inmueble = new Types.ObjectId();
const tercero = new Types.ObjectId();
const concepto = new Types.ObjectId();
const cuenta = new Types.ObjectId();

const base = (over: Record<string, unknown> = {}) => ({
  coPropertyId: copropiedad,
  inmuebleId: inmueble,
  terceroId: tercero,
  conceptoId: concepto,
  fullNumber: 'ND-1',
  issueDate: new Date(),
  total: 150000,
  outstandingBalance: 150000,
  generatedBy: cuenta,
  ...over,
});

const validar = async (
  campos: Record<string, unknown>,
): Promise<Error | null> => {
  const doc = new NotaDebitoModel(base(campos));
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
};

describe('NotaDebitoSchema — forma', () => {
  it('acepta una nota débito bien formada', async () => {
    await expect(validar({})).resolves.toBeNull();
  });

  it('acepta terceroId null — el tercero puede no estar vinculado', async () => {
    await expect(validar({ terceroId: null })).resolves.toBeNull();
  });

  it('acepta description null', async () => {
    await expect(validar({ description: null })).resolves.toBeNull();
  });

  it('arranca emitida, con outstandingBalance igual a total y sin datos de anulación', () => {
    const doc = new NotaDebitoModel(base());
    expect(doc.status).toBe('emitida');
    expect(doc.outstandingBalance).toBe(doc.total);
    expect(doc.voidedReason).toBeNull();
    expect(doc.voidedDetail).toBeNull();
    expect(doc.voidedAt).toBeNull();
    expect(doc.voidedBy).toBeNull();
  });

  it('exige conceptoId', async () => {
    const error = await validar({ conceptoId: undefined });
    expect(error?.message).toContain('conceptoId');
  });

  it('exige issueDate', async () => {
    const error = await validar({ issueDate: undefined });
    expect(error?.message).toContain('issueDate');
  });

  it('exige total', async () => {
    const error = await validar({ total: undefined });
    expect(error?.message).toContain('total');
  });

  it('exige outstandingBalance', async () => {
    const error = await validar({ outstandingBalance: undefined });
    expect(error?.message).toContain('outstandingBalance');
  });

  it('rechaza un estado fuera de emitida/anulada', async () => {
    await expect(validar({ status: 'pendiente' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('rechaza un motivo de anulación fuera del catálogo', async () => {
    await expect(
      validar({ voidedReason: 'porque_si' }),
    ).resolves.toBeInstanceOf(Error);
  });
});

describe('NotaDebitoSchema — índices', () => {
  it('el número completo es único por copropiedad', () => {
    const indice = indices().find(
      ([campos]) => campos.coPropertyId === 1 && campos.fullNumber === 1,
    );
    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({ unique: true });
  });

  it('indexa copropiedad + inmueble + saldo pendiente, para el listado por unidad', () => {
    const indice = indices().find(
      ([campos]) =>
        campos.coPropertyId === 1 &&
        campos.inmuebleId === 1 &&
        campos.outstandingBalance === 1,
    );
    expect(indice).toBeDefined();
  });
});

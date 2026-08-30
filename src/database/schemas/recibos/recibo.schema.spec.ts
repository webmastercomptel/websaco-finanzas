import mongoose, { Types } from 'mongoose';
import { ReciboSchema } from './recibo.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  ReciboSchema.indexes() as unknown as IndiceDeclarado[];

// A real model, so validation runs the way it will in production. Mongoose
// validates in memory — no database connection is involved here.
const ReciboModel = mongoose.model('ReciboSpec', ReciboSchema);

const copropiedad = new Types.ObjectId();
const inmueble = new Types.ObjectId();
const tercero = new Types.ObjectId();
const cuenta = new Types.ObjectId();

const base = (over: Record<string, unknown> = {}) => ({
  coPropertyId: copropiedad,
  inmuebleId: inmueble,
  terceroId: tercero,
  fullNumber: 'RC-1',
  receivedAmount: 500000,
  receivedDate: new Date('2026-08-27'),
  paymentMethod: 'transferencia',
  destinationAccount: '111005',
  unappliedAmount: 500000,
  generatedBy: cuenta,
  ...over,
});

const validar = async (
  campos: Record<string, unknown>,
): Promise<Error | null> => {
  const doc = new ReciboModel(base(campos));
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
};

describe('ReciboSchema — forma', () => {
  it('acepta un recibo bien formado', async () => {
    await expect(validar({})).resolves.toBeNull();
  });

  it('arranca activo, con appliedAmount en cero y sin datos de anulación', () => {
    const doc = new ReciboModel(base());
    expect(doc.status).toBe('activo');
    expect(doc.appliedAmount).toBe(0);
    expect(doc.voidedReason).toBeNull();
    expect(doc.voidedDetail).toBeNull();
    expect(doc.voidedAt).toBeNull();
  });

  it('rechaza un medioPago fuera del catálogo', async () => {
    await expect(validar({ paymentMethod: 'bitcoin' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('rechaza un estado fuera de activo/anulado', async () => {
    await expect(validar({ status: 'pendiente' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('exige terceroId', async () => {
    const error = await validar({ terceroId: undefined });
    expect(error?.message).toContain('terceroId');
  });
});

describe('ReciboSchema — índices', () => {
  it('el número completo es único por copropiedad', () => {
    const indice = indices().find(
      ([campos]) => campos.coPropertyId === 1 && campos.fullNumber === 1,
    );
    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({ unique: true });
  });

  it('indexa copropiedad + inmueble + saldo sin aplicar, para conAnticipoDisponible', () => {
    const indice = indices().find(
      ([campos]) =>
        campos.coPropertyId === 1 &&
        campos.inmuebleId === 1 &&
        campos.unappliedAmount === 1,
    );
    expect(indice).toBeDefined();
  });
});

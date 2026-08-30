import mongoose, { Types } from 'mongoose';
import { AplicacionReciboSchema } from './aplicacion-recibo.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  AplicacionReciboSchema.indexes() as unknown as IndiceDeclarado[];

const AplicacionModel = mongoose.model(
  'AplicacionReciboSpec',
  AplicacionReciboSchema,
);

const copropiedad = new Types.ObjectId();
const recibo = new Types.ObjectId();
const factura = new Types.ObjectId();
const cuenta = new Types.ObjectId();

const base = (over: Record<string, unknown> = {}) => ({
  coPropertyId: copropiedad,
  reciboId: recibo,
  documentType: 'FV',
  documentId: factura,
  amountApplied: 250000,
  appliedAt: new Date('2026-08-27'),
  appliedBy: cuenta,
  ...over,
});

const validar = async (
  campos: Record<string, unknown>,
): Promise<Error | null> => {
  const doc = new AplicacionModel(base(campos));
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
};

describe('AplicacionReciboSchema — forma', () => {
  it('acepta una aplicación contra una factura', async () => {
    await expect(validar({})).resolves.toBeNull();
  });

  it('arranca activa', () => {
    const doc = new AplicacionModel(base());
    expect(doc.status).toBe('activa');
  });

  it('admite el tipo ND, reservado para Notas Débito (fuera de alcance hoy)', async () => {
    await expect(
      validar({ documentType: 'ND' }),
    ).resolves.toBeNull();
  });

  it('rechaza un tipo de documento fuera del catálogo', async () => {
    await expect(validar({ documentType: 'NC' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('rechaza un estado fuera de activa/revertida', async () => {
    await expect(validar({ status: 'pendiente' })).resolves.toBeInstanceOf(
      Error,
    );
  });
});

describe('AplicacionReciboSchema — índices', () => {
  it('indexa por documento, para "cada aplicación contra la factura X"', () => {
    const indice = indices().find(
      ([campos]) => campos.documentType === 1 && campos.documentId === 1,
    );
    expect(indice).toBeDefined();
  });

  it('indexa por recibo, para el cascade de anulación', () => {
    const indice = indices().find(([campos]) => campos.reciboId === 1);
    expect(indice).toBeDefined();
  });
});

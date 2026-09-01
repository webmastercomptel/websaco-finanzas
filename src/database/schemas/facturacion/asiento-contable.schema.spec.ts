import mongoose, { Types } from 'mongoose';
import { AsientoContableSchema } from './asiento-contable.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  AsientoContableSchema.indexes() as unknown as IndiceDeclarado[];

const AsientoModel = mongoose.model(
  'AsientoContableSpec',
  AsientoContableSchema,
);

const copropiedad = new Types.ObjectId();
const lote = new Types.ObjectId();
const factura = new Types.ObjectId();
const recibo = new Types.ObjectId();
const notaCredito = new Types.ObjectId();

const entradasBalanceadas = [
  { account: '111005', type: 'debito', amount: 100000, description: 'x' },
  { account: '130501', type: 'credito', amount: 100000, description: 'x' },
];

const validar = async (
  campos: Record<string, unknown>,
): Promise<Error | null> => {
  const doc = new AsientoModel({
    coPropertyId: copropiedad,
    date: new Date('2026-08-27'),
    entries: entradasBalanceadas,
    ...campos,
  });
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
};

describe('AsientoContableSchema — anclaje Factura/Lote (existente) vs Recibo (nuevo)', () => {
  it('sigue aceptando un asiento de facturación, con loteId y facturaId', async () => {
    await expect(
      validar({ loteId: lote, facturaId: factura }),
    ).resolves.toBeNull();
  });

  it('acepta un asiento de recibo, SIN loteId ni facturaId', async () => {
    await expect(validar({ reciboId: recibo })).resolves.toBeNull();
  });

  it('loteId y facturaId son opcionales ahora (default null)', () => {
    const doc = new AsientoModel({
      coPropertyId: copropiedad,
      date: new Date(),
      entries: entradasBalanceadas,
      reciboId: recibo,
    });
    expect(doc.loteId).toBeNull();
    expect(doc.facturaId).toBeNull();
  });

  it('acepta un asiento de nota crédito, SIN loteId, facturaId ni reciboId', async () => {
    await expect(validar({ notaCreditoId: notaCredito })).resolves.toBeNull();
  });
});

describe('AsientoContableSchema — índices', () => {
  it('la unicidad por factura está acotada a los asientos que SÍ tienen factura', () => {
    // Sin el filtro parcial, todo asiento de recibo (facturaId: null) chocaría
    // contra los demás asientos de recibo en un índice único común.
    const indice = indices().find(
      ([campos], i, arr) =>
        campos.facturaId === 1 && Object.keys(campos).length === 1,
    );
    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({ unique: true });
    expect(indice?.[1].partialFilterExpression).toBeDefined();
  });

  it('indexa por recibo, para encontrar todos los asientos que produjo', () => {
    const indice = indices().find(([campos]) => campos.reciboId === 1);
    expect(indice).toBeDefined();
  });

  it('indexa por nota crédito, para encontrar todos los asientos que produjo', () => {
    const indice = indices().find(([campos]) => campos.notaCreditoId === 1);
    expect(indice).toBeDefined();
  });
});

import mongoose, { Types } from 'mongoose';
import { AplicacionCarteraSchema } from './aplicacion-cartera.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  AplicacionCarteraSchema.indexes() as unknown as IndiceDeclarado[];

const AplicacionModel = mongoose.model(
  'AplicacionCarteraSpec',
  AplicacionCarteraSchema,
);

const copropiedad = new Types.ObjectId();
const recibo = new Types.ObjectId();
const factura = new Types.ObjectId();
const cuenta = new Types.ObjectId();

const base = (over: Record<string, unknown> = {}) => ({
  coPropertyId: copropiedad,
  sourceType: 'RC',
  sourceId: recibo,
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

describe('AplicacionCarteraSchema — forma', () => {
  it('acepta una aplicación de Recibo (sourceType RC) contra una factura', async () => {
    await expect(validar({})).resolves.toBeNull();
  });

  it('acepta una aplicación de Nota Crédito (sourceType NC)', async () => {
    await expect(
      validar({ sourceType: 'NC', sourceId: new Types.ObjectId() }),
    ).resolves.toBeNull();
  });

  it('rechaza un sourceType fuera de RC/NC', async () => {
    await expect(validar({ sourceType: 'ND' })).resolves.toBeInstanceOf(Error);
  });

  it('arranca activa', () => {
    const doc = new AplicacionModel(base());
    expect(doc.status).toBe('activa');
  });

  it('admite el tipo de documento ND, reservado para Notas Débito (fuera de alcance hoy)', async () => {
    await expect(validar({ documentType: 'ND' })).resolves.toBeNull();
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

describe('AplicacionCarteraSchema — índices (generalización, no duplicación)', () => {
  it('indexa por documento, para "cada aplicación contra la factura X"', () => {
    const indice = indices().find(
      ([campos]) => campos.documentType === 1 && campos.documentId === 1,
    );
    expect(indice).toBeDefined();
  });

  it('indexa por sourceType+sourceId, reemplazando el viejo índice por reciboId', () => {
    const indice = indices().find(
      ([campos]) => campos.sourceType === 1 && campos.sourceId === 1,
    );
    expect(indice).toBeDefined();
  });

  it('no declara ningún índice sobre el campo viejo reciboId — la generalización reemplazó el campo, no lo dejó vivo al lado del nuevo', () => {
    const indiceViejo = indices().find(([campos]) => 'reciboId' in campos);
    expect(indiceViejo).toBeUndefined();
  });

  it('declara exactamente dos índices propios (documento y source) — ninguno de más', () => {
    // Además de los `index: true` de `_id`/`coPropertyId` que Mongoose agrega
    // por su cuenta, este schema declara sus dos índices compuestos y nada
    // más — una tercera entrada acá sería el síntoma exacto del bug de
    // AsientoContable.facturaId: un índice viejo sobreviviendo al lado del
    // nuevo.
    const compuestos = indices().filter(
      ([campos]) => Object.keys(campos).length === 2,
    );
    expect(compuestos).toHaveLength(2);
  });
});

import mongoose from 'mongoose';
import { TerceroSchema } from './tercero.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const TerceroModel = mongoose.model('TerceroSpec', TerceroSchema);

describe('TerceroSchema — addresses', () => {
  it('trims every element of emails on the way in, keeping its case', () => {
    const tercero = new TerceroModel({
      emails: ['  Ana@Example.com ', 'b@x.co'],
    });
    expect(Array.from(tercero.emails)).toEqual(['Ana@Example.com', 'b@x.co']);
  });

  it('defaults to an empty list', () => {
    expect(Array.from(new TerceroModel({}).emails)).toEqual([]);
  });

  it('declares the emails_ci collation index, non-unique', () => {
    const indice = (
      TerceroSchema.indexes() as unknown as IndiceDeclarado[]
    ).find(([, opciones]) => opciones.name === 'emails_ci');
    expect(indice).toBeDefined();
    expect(indice?.[0]).toEqual({ emails: 1 });
    expect(indice?.[1]).toMatchObject({
      collation: { locale: 'en', strength: 2 },
    });
    expect(indice?.[1].unique).toBeUndefined();
  });
});

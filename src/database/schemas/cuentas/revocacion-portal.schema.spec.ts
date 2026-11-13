import mongoose, { Types } from 'mongoose';
import { RevocacionPortalSchema } from './revocacion-portal.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  RevocacionPortalSchema.indexes() as unknown as IndiceDeclarado[];

const RevocacionModel = mongoose.model(
  'RevocacionPortalSpec',
  RevocacionPortalSchema,
);

describe('RevocacionPortalSchema', () => {
  it('lives in revocaciones_portal', () => {
    expect(RevocacionModel.collection.name).toBe('revocaciones_portal');
  });

  it('declares one row per revoke event with who/when of both transitions', () => {
    const campos = Object.keys(RevocacionPortalSchema.paths).filter(
      (c) => !c.startsWith('_'),
    );
    expect(campos.sort()).toEqual(
      [
        'activa',
        'clave',
        'copropiedadId',
        'levantadaEn',
        'levantadaPor',
        'revocadaEn',
        'revocadaPor',
      ].sort(),
    );
  });

  it('SEC: no field can hold an address (only the clave)', () => {
    const campos = Object.keys(RevocacionPortalSchema.paths);
    for (const prohibido of ['correo', 'email', 'emails', 'direccion']) {
      expect(campos).not.toContain(prohibido);
    }
    // A strict schema drops anything undeclared on save.
    const doc = new RevocacionModel({
      copropiedadId: new Types.ObjectId(),
      clave: 'a'.repeat(64),
      correo: 'ana@example.com',
    });
    expect(doc.toObject()).not.toHaveProperty('correo');
  });

  it('starts active, lifted fields empty', () => {
    const doc = new RevocacionModel({
      copropiedadId: new Types.ObjectId(),
      clave: 'a'.repeat(64),
      revocadaPor: new Types.ObjectId(),
      revocadaEn: new Date(),
    });
    expect(doc.activa).toBe(true);
    expect(doc.levantadaPor).toBeNull();
    expect(doc.levantadaEn).toBeNull();
  });

  it('allows ONE active row per (coproperty, clave) and any number of lifted ones', () => {
    const unico = indices().find(
      ([campos]) => campos.copropiedadId === 1 && campos.clave === 1,
    );
    expect(unico).toBeDefined();
    expect(unico?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { activa: true },
    });
  });

  it('indexes {clave, activa} for the derivation', () => {
    const indice = indices().find(
      ([campos]) =>
        campos.clave === 1 &&
        campos.activa === 1 &&
        campos.copropiedadId === undefined,
    );
    expect(indice).toBeDefined();
    expect(indice?.[1]).not.toMatchObject({ unique: true });
  });
});

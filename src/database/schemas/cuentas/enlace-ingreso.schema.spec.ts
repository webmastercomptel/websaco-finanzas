import mongoose, { Types } from 'mongoose';
import { EnlaceIngresoSchema } from './enlace-ingreso.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  EnlaceIngresoSchema.indexes() as unknown as IndiceDeclarado[];

const EnlaceModel = mongoose.model('EnlaceIngresoSpec', EnlaceIngresoSchema);

describe('EnlaceIngresoSchema', () => {
  it('lives in enlaces_ingreso', () => {
    expect(EnlaceModel.collection.name).toBe('enlaces_ingreso');
  });

  it('declares the fields of a sign-in link and no field for the token', () => {
    const campos = Object.keys(EnlaceIngresoSchema.paths)
      .filter((c) => !c.startsWith('_'))
      .sort();
    expect(campos).toEqual(
      [
        'clave',
        'correo',
        'createdAt',
        'expiraEn',
        'origen',
        'solicitadoPor',
        'tokenHash',
        'usadoEn',
      ].sort(),
    );
    expect(campos).not.toContain('token');
  });

  it('starts unused, self-service and without a staff requester', () => {
    const doc = new EnlaceModel({
      tokenHash: 'h'.repeat(64),
      clave: 'c'.repeat(64),
      correo: 'ana@example.com',
      expiraEn: new Date(),
    });
    expect(doc.usadoEn).toBeNull();
    expect(doc.solicitadoPor).toBeNull();
    expect(doc.origen).toBe('autoservicio');
  });

  it('only accepts the two origins', () => {
    const doc = new EnlaceModel({
      tokenHash: 'h'.repeat(64),
      clave: 'c'.repeat(64),
      correo: 'ana@example.com',
      expiraEn: new Date(),
      origen: 'otro',
      solicitadoPor: new Types.ObjectId(),
    });
    expect(doc.validateSync()?.errors.origen).toBeDefined();
  });

  it('makes tokenHash unique', () => {
    const unico = indices().find(([campos]) => campos.tokenHash === 1);
    expect(unico?.[1]).toMatchObject({ unique: true });
  });

  it('indexes {clave, usadoEn} to invalidate earlier links of an address', () => {
    const indice = indices().find(
      ([campos]) => campos.clave === 1 && campos.usadoEn === 1,
    );
    expect(indice).toBeDefined();
  });

  it('purges rows at expiry with a TTL index', () => {
    const ttl = indices().find(([campos]) => campos.expiraEn === 1);
    expect(ttl?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });
});

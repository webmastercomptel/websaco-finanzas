import { CopropiedadSchema } from './copropiedad.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  CopropiedadSchema.indexes() as unknown as IndiceDeclarado[];

// spec `copropiedad-websaco3-link` → "Index is a partial unique index managed
// by a script". The unit tests never touch a database, so this pins the
// declaration the script (scripts/migrate-copropiedad-websaco3-id-index.js)
// must mirror.
describe('Copropiedad schema — índice de websaco3CopropiedadId', () => {
  it('declara un índice único y parcial solo sobre ids de tipo string', () => {
    const indice = indices().find(
      ([clave]) => Object.keys(clave).join() === 'websaco3CopropiedadId',
    );

    expect(indice).toBeDefined();
    expect(indice![0]).toEqual({ websaco3CopropiedadId: 1 });
    expect(indice![1]).toMatchObject({
      unique: true,
      partialFilterExpression: { websaco3CopropiedadId: { $type: 'string' } },
    });
  });

  it('no fija un nombre propio: queda el predeterminado websaco3CopropiedadId_1 que el script usa', () => {
    const indice = indices().find(
      ([clave]) => Object.keys(clave).join() === 'websaco3CopropiedadId',
    );

    expect(indice![1].name).toBeUndefined();
  });
});

// Same pin for the Comptable link: the script
// (scripts/migrate-copropiedad-comptable-id-index.js) must mirror it.
describe('Copropiedad schema — índice de comptableEmpresaId', () => {
  const indice = () =>
    indices().find(
      ([clave]) => Object.keys(clave).join() === 'comptableEmpresaId',
    );

  it('declara un índice único y parcial solo sobre ids de tipo string', () => {
    expect(indice()).toBeDefined();
    expect(indice()![0]).toEqual({ comptableEmpresaId: 1 });
    expect(indice()![1]).toMatchObject({
      unique: true,
      partialFilterExpression: { comptableEmpresaId: { $type: 'string' } },
    });
  });

  it('no fija un nombre propio: queda el predeterminado comptableEmpresaId_1 que el script usa', () => {
    expect(indice()![1].name).toBeUndefined();
  });
});

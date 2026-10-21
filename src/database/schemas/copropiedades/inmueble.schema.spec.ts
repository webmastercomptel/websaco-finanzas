import { InmuebleSchema } from './inmueble.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  InmuebleSchema.indexes() as unknown as IndiceDeclarado[];

const clavesCodigo = (): IndiceDeclarado[] =>
  indices().filter(
    ([clave]) => Object.keys(clave).join() === 'copropiedadId,codigo',
  );

// The unit tests never touch a database, so this pins the declarations that
// make a unit code unique inside one coproperty.
describe('Inmueble schema — unicidad del código', () => {
  it('mantiene el índice único exacto sobre (copropiedadId, codigo)', () => {
    const exacto = clavesCodigo().find(([, opciones]) => !opciones.collation);

    expect(exacto).toBeDefined();
    expect(exacto![0]).toEqual({ copropiedadId: 1, codigo: 1 });
    expect(exacto![1]).toMatchObject({ unique: true });
    // No explicit name: the default one is what already exists in production.
    expect(exacto![1].name).toBeUndefined();
  });

  it('declara además un índice único insensible a mayúsculas sobre (copropiedadId, codigo)', () => {
    const insensible = clavesCodigo().find(
      ([, opciones]) => opciones.collation !== undefined,
    );

    expect(insensible).toBeDefined();
    expect(insensible![0]).toEqual({ copropiedadId: 1, codigo: 1 });
    expect(insensible![1]).toMatchObject({
      unique: true,
      collation: { locale: 'en', strength: 2 },
    });
  });

  it('el índice insensible tiene nombre propio, distinto del predeterminado, para que Mongoose lo cree sin tocar el existente', () => {
    const insensible = clavesCodigo().find(
      ([, opciones]) => opciones.collation !== undefined,
    );

    expect(insensible![1].name).toBe('copropiedadId_1_codigo_1_ci');
    expect(insensible![1].name).not.toBe('copropiedadId_1_codigo_1');
  });

  it('guarda el código sin espacios alrededor (trim)', () => {
    const ruta = InmuebleSchema.path('codigo') as unknown as {
      options: { trim?: boolean; required?: boolean };
    };

    expect(ruta.options.trim).toBe(true);
    expect(ruta.options.required).toBe(true);
  });
});

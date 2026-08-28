import mongoose, { Types } from 'mongoose';
import { AsignacionSchema } from './asignacion.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  AsignacionSchema.indexes() as unknown as IndiceDeclarado[];

// A real model, so validation runs the way it will in production. Mongoose
// validates in memory — no database connection is involved here.
const AsignacionModel = mongoose.model('AsignacionSpec', AsignacionSchema);

const cuenta = new Types.ObjectId();
const copropiedad = new Types.ObjectId();
const entidad = new Types.ObjectId();

/** Returns the validation error, or null when the document is acceptable. */
const validar = async (
  campos: Record<string, unknown>,
): Promise<Error | null> => {
  const doc = new AsignacionModel({ accountId: cuenta, ...campos });
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
};

describe('AsignacionSchema — forma del otorgamiento', () => {
  it('acepta una asignación a una copropiedad', async () => {
    await expect(
      validar({ scope: 'copropiedad', coPropertyId: copropiedad }),
    ).resolves.toBeNull();
  });

  it('acepta una asignación a una entidad administradora', async () => {
    await expect(
      validar({ scope: 'entidad', entidadId: entidad }),
    ).resolves.toBeNull();
  });

  it('rechaza alcance copropiedad sin copropiedad', async () => {
    // Guardaría bien y después no otorgaría nada, que se lee como "los
    // permisos están rotos" en vez de "esta fila está mal armada".
    await expect(validar({ scope: 'copropiedad' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('rechaza alcance entidad sin entidad', async () => {
    await expect(validar({ scope: 'entidad' })).resolves.toBeInstanceOf(Error);
  });

  it('rechaza una fila que apunte a las dos cosas a la vez', async () => {
    // Ambigua por definición: no hay forma de saber qué quiso decir quien la
    // creó, y adivinarlo otorgaría acceso que nadie pidió.
    await expect(
      validar({
        scope: 'copropiedad',
        coPropertyId: copropiedad,
        entidadId: entidad,
      }),
    ).resolves.toBeInstanceOf(Error);

    await expect(
      validar({
        scope: 'entidad',
        coPropertyId: copropiedad,
        entidadId: entidad,
      }),
    ).resolves.toBeInstanceOf(Error);
  });

  it('el mensaje de error dice qué falta', async () => {
    const error = await validar({ scope: 'entidad' });

    expect(error?.message).toContain('entidadId');
  });

  it('exige un alcance conocido', async () => {
    await expect(
      validar({ scope: 'inventado', coPropertyId: copropiedad }),
    ).resolves.toBeInstanceOf(Error);
  });

  it('arranca sin permisos, nunca con permisos por defecto', () => {
    const doc = new AsignacionModel({
      accountId: cuenta,
      scope: 'copropiedad',
      coPropertyId: copropiedad,
    });

    // Un default distinto de vacío otorgaría acceso que nadie escribió.
    expect(doc.permissions).toEqual([]);
    expect(doc.status).toBe('active');
  });
});

describe('AsignacionSchema — índices', () => {
  it('la unicidad por copropiedad está acotada a ese alcance', () => {
    // Sin el filtro parcial, todas las filas de alcance "entidad" tienen
    // coPropertyId null y chocarían entre sí en un índice único común.
    const indice = indices().find(
      ([campos]) => campos.accountId === 1 && campos.coPropertyId === 1,
    );

    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { scope: 'copropiedad' },
    });
  });

  it('la unicidad por entidad está acotada a ese alcance', () => {
    const indice = indices().find(
      ([campos]) => campos.accountId === 1 && campos.entidadId === 1,
    );

    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { scope: 'entidad' },
    });
  });
});

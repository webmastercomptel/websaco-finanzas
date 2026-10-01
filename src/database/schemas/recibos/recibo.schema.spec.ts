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
  copropiedadId: copropiedad,
  inmuebleId: inmueble,
  terceroId: tercero,
  numeroCompleto: 'RC-1',
  montoRecibido: 500000,
  fechaRecibo: new Date('2026-08-27'),
  medioPago: 'transferencia',
  cuentaDestino: '111005',
  montoSinAplicar: 500000,
  generadoPor: cuenta,
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

  it('arranca activo, con montoAplicado en cero y sin datos de anulación', () => {
    const doc = new ReciboModel(base());
    expect(doc.estado).toBe('activo');
    expect(doc.montoAplicado).toBe(0);
    expect(doc.motivoAnulacion).toBeNull();
    expect(doc.detalleAnulacion).toBeNull();
    expect(doc.fechaAnulacion).toBeNull();
  });

  it('rechaza un medioPago fuera del catálogo', async () => {
    await expect(validar({ medioPago: 'bitcoin' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('rechaza un estado fuera de activo/anulado', async () => {
    await expect(validar({ estado: 'pendiente' })).resolves.toBeInstanceOf(
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
      ([campos]) => campos.copropiedadId === 1 && campos.numeroCompleto === 1,
    );
    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({ unique: true });
  });

  it('indexa copropiedad + inmueble + saldo sin aplicar, para conAnticipoDisponible', () => {
    const indice = indices().find(
      ([campos]) =>
        campos.copropiedadId === 1 &&
        campos.inmuebleId === 1 &&
        campos.montoSinAplicar === 1,
    );
    expect(indice).toBeDefined();
  });
});

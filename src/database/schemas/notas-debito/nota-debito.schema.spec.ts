import mongoose, { Types } from 'mongoose';
import { NotaDebitoSchema } from './nota-debito.schema';

type IndiceDeclarado = [Record<string, number>, Record<string, unknown>];

const indices = (): IndiceDeclarado[] =>
  NotaDebitoSchema.indexes() as unknown as IndiceDeclarado[];

const NotaDebitoModel = mongoose.model('NotaDebitoSpec', NotaDebitoSchema);

const copropiedad = new Types.ObjectId();
const inmueble = new Types.ObjectId();
const tercero = new Types.ObjectId();
const concepto = new Types.ObjectId();
const cuenta = new Types.ObjectId();

const base = (over: Record<string, unknown> = {}) => ({
  copropiedadId: copropiedad,
  inmuebleId: inmueble,
  terceroId: tercero,
  conceptoId: concepto,
  motivo: 'intereses',
  numeroCompleto: 'ND-1',
  fechaEmision: new Date(),
  fechaVencimiento: new Date(),
  total: 150000,
  saldoPendiente: 150000,
  generadoPor: cuenta,
  ...over,
});

const validar = async (
  campos: Record<string, unknown>,
): Promise<Error | null> => {
  const doc = new NotaDebitoModel(base(campos));
  try {
    await doc.validate();
    return null;
  } catch (err) {
    return err as Error;
  }
};

describe('NotaDebitoSchema — forma', () => {
  it('acepta una nota débito bien formada', async () => {
    await expect(validar({})).resolves.toBeNull();
  });

  it('acepta terceroId null — el tercero puede no estar vinculado', async () => {
    await expect(validar({ terceroId: null })).resolves.toBeNull();
  });

  it('acepta descripcion null', async () => {
    await expect(validar({ descripcion: null })).resolves.toBeNull();
  });

  it('arranca emitida, con saldoPendiente igual a total y sin datos de anulación', () => {
    const doc = new NotaDebitoModel(base());
    expect(doc.estado).toBe('emitida');
    expect(doc.saldoPendiente).toBe(doc.total);
    expect(doc.motivoAnulacion).toBeNull();
    expect(doc.detalleAnulacion).toBeNull();
    expect(doc.fechaAnulacion).toBeNull();
    expect(doc.anuladoPor).toBeNull();
  });

  it('exige conceptoId', async () => {
    const error = await validar({ conceptoId: undefined });
    expect(error?.message).toContain('conceptoId');
  });

  it('exige motivo (el motivo DIAN de la corrección)', async () => {
    const error = await validar({ motivo: undefined });
    expect(error?.message).toContain('motivo');
  });

  it('rechaza un motivo fuera del catálogo DIAN', async () => {
    await expect(validar({ motivo: 'porque_si' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('exige fechaEmision', async () => {
    const error = await validar({ fechaEmision: undefined });
    expect(error?.message).toContain('fechaEmision');
  });

  it('exige total', async () => {
    const error = await validar({ total: undefined });
    expect(error?.message).toContain('total');
  });

  it('exige saldoPendiente', async () => {
    const error = await validar({ saldoPendiente: undefined });
    expect(error?.message).toContain('saldoPendiente');
  });

  it('rechaza un estado fuera de emitida/anulada', async () => {
    await expect(validar({ estado: 'pendiente' })).resolves.toBeInstanceOf(
      Error,
    );
  });

  it('rechaza un motivo de anulación fuera del catálogo', async () => {
    await expect(
      validar({ motivoAnulacion: 'porque_si' }),
    ).resolves.toBeInstanceOf(Error);
  });
});

describe('NotaDebitoSchema — índices', () => {
  it('el número completo es único por copropiedad', () => {
    const indice = indices().find(
      ([campos]) => campos.copropiedadId === 1 && campos.numeroCompleto === 1,
    );
    expect(indice).toBeDefined();
    expect(indice?.[1]).toMatchObject({ unique: true });
  });

  it('indexa copropiedad + inmueble + saldo pendiente, para el listado por unidad', () => {
    const indice = indices().find(
      ([campos]) =>
        campos.copropiedadId === 1 &&
        campos.inmuebleId === 1 &&
        campos.saldoPendiente === 1,
    );
    expect(indice).toBeDefined();
  });
});

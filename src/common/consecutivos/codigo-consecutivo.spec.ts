import type { Model } from 'mongoose';
import type { ConsecutivoAdministracionDocument } from '../../database/schemas/administracion/consecutivo-administracion.schema';
import {
  asegurarConsecutivoMinimo,
  siguienteCodigo,
  siguienteNumero,
} from './codigo-consecutivo';

type ModeloConsecutivo = Model<ConsecutivoAdministracionDocument>;

function modeloConsecutivo(valor: number) {
  const exec = jest.fn().mockResolvedValue({ valor });
  const findOneAndUpdate = jest.fn().mockReturnValue({ exec });
  const updateExec = jest.fn().mockResolvedValue({});
  const updateOne = jest.fn().mockReturnValue({ exec: updateExec });
  return {
    modelo: { findOneAndUpdate, updateOne } as unknown as ModeloConsecutivo,
    findOneAndUpdate,
    updateOne,
  };
}

describe('siguienteCodigo', () => {
  it('incrementa el consecutivo del prefijo de forma atómica y con upsert', async () => {
    const { modelo, findOneAndUpdate } = modeloConsecutivo(1);

    await siguienteCodigo(modelo, 'PQR');

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { clave: 'PQR' },
      { $inc: { valor: 1 } },
      { upsert: true, new: true },
    );
  });

  it('formatea con relleno de ceros (3 por defecto)', async () => {
    const { modelo } = modeloConsecutivo(7);

    await expect(siguienteCodigo(modelo, 'PQR')).resolves.toBe('PQR-007');
  });

  it('no recorta números que exceden el ancho', async () => {
    const { modelo } = modeloConsecutivo(1234);

    await expect(siguienteCodigo(modelo, 'MNT')).resolves.toBe('MNT-1234');
  });

  it('acepta otro ancho', async () => {
    const { modelo } = modeloConsecutivo(5);

    await expect(siguienteCodigo(modelo, 'DOC', 5)).resolves.toBe('DOC-00005');
  });
});

describe('siguienteNumero', () => {
  it('usa la clave tal cual (una secuencia por copropiedad, por ejemplo) y devuelve el número', async () => {
    const { modelo, findOneAndUpdate } = modeloConsecutivo(12);

    await expect(siguienteNumero(modelo, 'ROL:abc')).resolves.toBe(12);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { clave: 'ROL:abc' },
      { $inc: { valor: 1 } },
      { upsert: true, new: true },
    );
  });
});

describe('asegurarConsecutivoMinimo', () => {
  it('sube el consecutivo al mínimo sin bajarlo nunca ($max) y crea la clave si falta', async () => {
    const { modelo, updateOne } = modeloConsecutivo(0);

    await asegurarConsecutivoMinimo(modelo, 'PQR', 892);

    expect(updateOne).toHaveBeenCalledWith(
      { clave: 'PQR' },
      { $max: { valor: 892 } },
      { upsert: true },
    );
  });
});

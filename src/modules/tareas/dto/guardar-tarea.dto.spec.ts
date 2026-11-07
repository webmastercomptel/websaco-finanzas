import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { CrearTareaDto } from './guardar-tarea.dto';

const propiedadesInvalidas = async (plano: Record<string, unknown>) =>
  (await validate(plainToInstance(CrearTareaDto, plano))).map(
    (e) => e.property,
  );

describe('CrearTareaDto — asignadosIds', () => {
  it('rechaza ids duplicados en asignadosIds', async () => {
    const id = new Types.ObjectId().toString();

    const errores = await propiedadesInvalidas({
      titulo: 'Limpiar zona común',
      categoria: 'limpieza',
      asignadosIds: [id, id],
    });

    expect(errores).toContain('asignadosIds');
  });

  it('acepta ids únicos en asignadosIds', async () => {
    const errores = await propiedadesInvalidas({
      titulo: 'Limpiar zona común',
      categoria: 'limpieza',
      asignadosIds: [
        new Types.ObjectId().toString(),
        new Types.ObjectId().toString(),
      ],
    });

    expect(errores).not.toContain('asignadosIds');
  });

  it('rechaza un asignado que no es un ObjectId', async () => {
    const errores = await propiedadesInvalidas({
      titulo: 'x',
      categoria: 'admin',
      asignadosIds: ['no-es-un-id'],
    });

    expect(errores).toContain('asignadosIds');
  });
});

describe('CrearTareaDto — campos del contrato', () => {
  it('acepta el payload mínimo (título y categoría)', async () => {
    expect(
      await propiedadesInvalidas({ titulo: 'Algo', categoria: 'admin' }),
    ).toEqual([]);
  });

  it('rechaza un título vacío', async () => {
    expect(
      await propiedadesInvalidas({ titulo: '', categoria: 'admin' }),
    ).toContain('titulo');
  });

  it.each([
    ['categoria', 'cleaning'],
    ['prioridad', 'high'],
    ['estado', 'pending'],
  ])(
    'rechaza el valor en inglés %s=%s (el contrato es en español)',
    async (campo, valor) => {
      const errores = await propiedadesInvalidas({
        titulo: 'x',
        categoria: 'admin',
        [campo]: valor,
      });

      expect(errores).toContain(campo);
    },
  );

  it('rechaza un progreso fuera de 0-100 y una fecha que no es ISO', async () => {
    const errores = await propiedadesInvalidas({
      titulo: 'x',
      categoria: 'admin',
      progreso: 101,
      fechaLimite: 'mañana',
    });

    expect(errores).toEqual(
      expect.arrayContaining(['progreso', 'fechaLimite']),
    );
  });

  it('el orden dentro de la columna se llama orden, no order', async () => {
    expect(
      await propiedadesInvalidas({ titulo: 'x', categoria: 'admin', orden: 2 }),
    ).toEqual([]);
  });
});

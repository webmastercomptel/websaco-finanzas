import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { ActualizarTareaDto } from './actualizar-tarea.dto';

const propiedadesInvalidas = async (plano: Record<string, unknown>) =>
  (await validate(plainToInstance(ActualizarTareaDto, plano))).map(
    (e) => e.property,
  );

describe('ActualizarTareaDto — asignadosIds', () => {
  it('rechaza ids duplicados en asignadosIds', async () => {
    const id = new Types.ObjectId().toString();

    expect(await propiedadesInvalidas({ asignadosIds: [id, id] })).toContain(
      'asignadosIds',
    );
  });

  it('acepta ids únicos en asignadosIds', async () => {
    expect(
      await propiedadesInvalidas({
        asignadosIds: [
          new Types.ObjectId().toString(),
          new Types.ObjectId().toString(),
        ],
      }),
    ).not.toContain('asignadosIds');
  });
});

describe('ActualizarTareaDto — campos del contrato', () => {
  it('acepta un cuerpo vacío (todo es opcional)', async () => {
    expect(await propiedadesInvalidas({})).toEqual([]);
  });

  it('acepta fechaLimite null (borra la fecha) y rechaza una que no es ISO', async () => {
    expect(await propiedadesInvalidas({ fechaLimite: null })).toEqual([]);
    expect(await propiedadesInvalidas({ fechaLimite: 'mañana' })).toContain(
      'fechaLimite',
    );
  });

  it('acepta el payload del arrastre en el tablero ({ estado, orden })', async () => {
    expect(
      await propiedadesInvalidas({ estado: 'en_progreso', orden: 4 }),
    ).toEqual([]);
  });

  it('rechaza un estado que no es una columna del tablero', async () => {
    expect(await propiedadesInvalidas({ estado: 'completed' })).toContain(
      'estado',
    );
  });
});

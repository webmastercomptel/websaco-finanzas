import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListarTareasDto } from './listar-tareas.dto';

const propiedadesInvalidas = async (plano: Record<string, unknown>) =>
  (await validate(plainToInstance(ListarTareasDto, plano))).map(
    (e) => e.property,
  );

describe('ListarTareasDto', () => {
  it.each(['todos', 'pendiente', 'en_progreso', 'completado'])(
    'acepta estado=%s',
    async (estado) => {
      expect(await propiedadesInvalidas({ estado })).toEqual([]);
    },
  );

  it('acepta la consulta sin estado', async () => {
    expect(await propiedadesInvalidas({})).toEqual([]);
  });

  it('rechaza un estado desconocido', async () => {
    expect(await propiedadesInvalidas({ estado: 'archivado' })).toContain(
      'estado',
    );
  });
});

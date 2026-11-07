import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarActividadDto } from './actualizar-actividad.dto';
import { CrearActividadDto } from './guardar-actividad.dto';
import { ListarActividadesDto } from './listar-actividades.dto';

const invalidas = async <T extends object>(
  clase: new () => T,
  plano: Record<string, unknown>,
) => (await validate(plainToInstance(clase, plano))).map((e) => e.property);

describe('ListarActividadesDto', () => {
  it.each([
    'todos',
    'integracion',
    'salud',
    'asamblea',
    'cultural',
    'deportivo',
    'operativo',
  ])('acepta categoria=%s', async (categoria) => {
    expect(await invalidas(ListarActividadesDto, { categoria })).toEqual([]);
  });

  it.each(['todos', 'proximo', 'en_curso', 'finalizado', 'cancelado'])(
    'acepta estado=%s',
    async (estado) => {
      expect(await invalidas(ListarActividadesDto, { estado })).toEqual([]);
    },
  );

  it('rechaza valores desconocidos (400 en vez de ignorarlos)', async () => {
    expect(
      await invalidas(ListarActividadesDto, { categoria: 'musica' }),
    ).toContain('categoria');
    expect(await invalidas(ListarActividadesDto, { estado: 'past' })).toContain(
      'estado',
    );
  });
});

describe('CrearActividadDto', () => {
  const valido = {
    titulo: 'Yoga',
    categoria: 'salud',
    fecha: '2026-09-10T08:00:00.000Z',
  };

  it('acepta un cuerpo mínimo válido y imagen null', async () => {
    expect(await invalidas(CrearActividadDto, valido)).toEqual([]);
    expect(
      await invalidas(CrearActividadDto, { ...valido, imagen: null }),
    ).toEqual([]);
  });

  it('rechaza capacidad negativa, fecha inválida y categoría desconocida', async () => {
    expect(
      await invalidas(CrearActividadDto, {
        ...valido,
        capacidad: -1,
        fecha: 'mañana',
        categoria: 'musica',
      }),
    ).toEqual(expect.arrayContaining(['capacidad', 'fecha', 'categoria']));
  });

  it('no admite escribir la lista de asistentes desde el formulario del administrador', async () => {
    const propiedades = (
      await validate(
        plainToInstance(CrearActividadDto, {
          ...valido,
          participantesIds: ['x'],
        }),
        { whitelist: true, forbidNonWhitelisted: true },
      )
    ).map((e) => e.property);

    expect(propiedades).toContain('participantesIds');
  });
});

describe('ActualizarActividadDto', () => {
  it('acepta un cuerpo vacío y rechaza valores inválidos', async () => {
    expect(await invalidas(ActualizarActividadDto, {})).toEqual([]);
    expect(
      await invalidas(ActualizarActividadDto, {
        estado: 'past',
        capacidad: -5,
      }),
    ).toEqual(expect.arrayContaining(['estado', 'capacidad']));
  });
});

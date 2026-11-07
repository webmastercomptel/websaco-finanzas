import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarMantenimientoDto } from './actualizar-mantenimiento.dto';
import { CrearMantenimientoDto } from './guardar-mantenimiento.dto';
import { ListarMantenimientosDto } from './listar-mantenimientos.dto';

const invalidas = async <T extends object>(
  clase: new () => T,
  plano: Record<string, unknown>,
) => (await validate(plainToInstance(clase, plano))).map((e) => e.property);

describe('ListarMantenimientosDto', () => {
  it.each(['todos', 'historial', 'preventivo', 'correctivo'])(
    'acepta tipo=%s',
    async (tipo) => {
      expect(await invalidas(ListarMantenimientosDto, { tipo })).toEqual([]);
    },
  );

  it.each(['todos', 'programado', 'en_progreso', 'completado', 'cancelado'])(
    'acepta estado=%s',
    async (estado) => {
      expect(await invalidas(ListarMantenimientosDto, { estado })).toEqual([]);
    },
  );

  it('acepta la consulta vacía', async () => {
    expect(await invalidas(ListarMantenimientosDto, {})).toEqual([]);
  });

  it('rechaza un tipo o un estado desconocido (400 en vez de ignorarlo)', async () => {
    expect(
      await invalidas(ListarMantenimientosDto, { tipo: 'urgente' }),
    ).toContain('tipo');
    expect(
      await invalidas(ListarMantenimientosDto, { estado: 'archivado' }),
    ).toContain('estado');
  });
});

describe('CrearMantenimientoDto', () => {
  const valido = {
    titulo: 'Revisión',
    tipo: 'preventivo',
    fecha: '2026-09-10T08:00:00.000Z',
    proveedor: { nombre: 'Ana' },
  };

  it('acepta un cuerpo mínimo válido', async () => {
    expect(await invalidas(CrearMantenimientoDto, valido)).toEqual([]);
  });

  it('rechaza tipo, estado o prioridad fuera de los valores del contrato', async () => {
    const propiedades = await invalidas(CrearMantenimientoDto, {
      ...valido,
      tipo: 'preventive',
      estado: 'scheduled',
      prioridad: 'critica',
    });

    expect(propiedades).toEqual(
      expect.arrayContaining(['tipo', 'estado', 'prioridad']),
    );
  });

  it('rechaza un tecnicoId que no es un ObjectId', async () => {
    expect(
      await invalidas(CrearMantenimientoDto, {
        ...valido,
        proveedor: { tecnicoId: 'abc' },
      }),
    ).toContain('proveedor');
  });
});

describe('ActualizarMantenimientoDto', () => {
  it('acepta un cuerpo vacío y rechaza valores inválidos', async () => {
    expect(await invalidas(ActualizarMantenimientoDto, {})).toEqual([]);
    expect(
      await invalidas(ActualizarMantenimientoDto, {
        estado: 'cancelled',
        completadoEn: 'ayer',
      }),
    ).toEqual(expect.arrayContaining(['estado', 'completadoEn']));
  });
});

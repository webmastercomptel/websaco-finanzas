import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Types } from 'mongoose';
import { ActualizarZonaDto } from './actualizar-zona.dto';
import { CrearZonaDto } from './guardar-zona.dto';
import { IniciarSubidaImagenZonaDto } from './iniciar-subida-imagen-zona.dto';
import { ListarEspaciosDto } from './listar-espacios.dto';
import { ListarZonasDto } from './listar-zonas.dto';

const invalidas = async <T extends object>(
  clase: new () => T,
  plano: Record<string, unknown>,
) => (await validate(plainToInstance(clase, plano))).map((e) => e.property);

describe('ListarZonasDto', () => {
  it.each([
    'todos',
    'deportiva',
    'social',
    'recreativa',
    'servicios',
    'parqueadero',
  ])('acepta tipo=%s', async (tipo) => {
    expect(await invalidas(ListarZonasDto, { tipo })).toEqual([]);
  });

  it.each(['todos', 'disponible', 'ocupada', 'mantenimiento', 'cerrada'])(
    'acepta estado=%s',
    async (estado) => {
      expect(await invalidas(ListarZonasDto, { estado })).toEqual([]);
    },
  );

  it('el pipe global rechaza con 400 el viejo ?coPropertyId=: el tenant nunca viene del cliente', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    await expect(
      pipe.transform(
        { coPropertyId: new Types.ObjectId().toString() },
        { type: 'query', metatype: ListarZonasDto },
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza valores desconocidos (400 en vez de ignorarlos) y los valores en inglés del original', async () => {
    expect(await invalidas(ListarZonasDto, { tipo: 'sports' })).toContain(
      'tipo',
    );
    expect(await invalidas(ListarZonasDto, { estado: 'available' })).toContain(
      'estado',
    );
  });
});

describe('ListarEspaciosDto', () => {
  it.each(['todos', 'deportes', 'social'])('acepta categoria=%s', async (c) => {
    expect(await invalidas(ListarEspaciosDto, { categoria: c })).toEqual([]);
  });

  it('rechaza una categoría desconocida', async () => {
    expect(
      await invalidas(ListarEspaciosDto, { categoria: 'piscina' }),
    ).toContain('categoria');
  });
});

describe('CrearZonaDto', () => {
  const valido = { nombre: 'Salón', tipo: 'social' };

  it('acepta un cuerpo mínimo y uno completo con costo e imagen nulos', async () => {
    expect(await invalidas(CrearZonaDto, valido)).toEqual([]);
    expect(
      await invalidas(CrearZonaDto, {
        ...valido,
        descripcion: 'd',
        capacidad: 0,
        horario: '08:00 - 20:00',
        requiereReserva: true,
        costo: null,
        imagen: null,
        reglas: ['a'],
        estado: 'mantenimiento',
      }),
    ).toEqual([]);
  });

  it('exige nombre y un tipo del contrato', async () => {
    expect(await invalidas(CrearZonaDto, { tipo: 'social' })).toContain(
      'nombre',
    );
    expect(
      await invalidas(CrearZonaDto, { ...valido, tipo: 'sports' }),
    ).toContain('tipo');
  });

  it('rechaza capacidad negativa y estado desconocido', async () => {
    const malas = await invalidas(CrearZonaDto, {
      ...valido,
      capacidad: -1,
      estado: 'closed',
    });
    expect(malas).toEqual(expect.arrayContaining(['capacidad', 'estado']));
  });
});

describe('ActualizarZonaDto', () => {
  it('acepta un cuerpo vacío (todo es opcional)', async () => {
    expect(await invalidas(ActualizarZonaDto, {})).toEqual([]);
  });

  it('rechaza un tipo o estado desconocido', async () => {
    const malas = await invalidas(ActualizarZonaDto, {
      tipo: 'x',
      estado: 'y',
    });
    expect(malas).toEqual(expect.arrayContaining(['tipo', 'estado']));
  });
});

describe('IniciarSubidaImagenZonaDto', () => {
  it('exige nombre, mimeType y un tamaño entero positivo', async () => {
    expect(
      await invalidas(IniciarSubidaImagenZonaDto, {
        nombre: 'a.png',
        mimeType: 'image/png',
        tamanoBytes: 10,
      }),
    ).toEqual([]);
    expect(
      await invalidas(IniciarSubidaImagenZonaDto, { tamanoBytes: 0 }),
    ).toEqual(expect.arrayContaining(['nombre', 'mimeType', 'tamanoBytes']));
  });
});

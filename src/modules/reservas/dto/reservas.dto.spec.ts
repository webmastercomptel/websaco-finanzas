import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ActualizarEstadoReservaDto } from './actualizar-estado-reserva.dto';
import { CrearReservaDto } from './guardar-reserva.dto';
import { CrearReservaPortalDto } from './guardar-reserva-portal.dto';
import { ListarDisponibilidadDto } from './listar-disponibilidad.dto';

const invalidas = async <T extends object>(
  clase: new () => T,
  plano: Record<string, unknown>,
) => (await validate(plainToInstance(clase, plano))).map((e) => e.property);

const ID = '65f1a2b3c4d5e6f708192a3b';
const base = {
  espacioId: ID,
  inicio: '2026-09-01T14:00:00.000Z',
  fin: '2026-09-01T16:00:00.000Z',
};

describe('CrearReservaDto (personal)', () => {
  it('acepta un cuerpo mínimo y uno con residente, inmueble y motivo', async () => {
    expect(await invalidas(CrearReservaDto, base)).toEqual([]);
    expect(
      await invalidas(CrearReservaDto, {
        ...base,
        residente: 'Juan',
        inmueble: '501',
        motivo: 'x',
      }),
    ).toEqual([]);
  });

  it('exige un espacioId válido y fechas ISO', async () => {
    const malas = await invalidas(CrearReservaDto, {
      espacioId: 'no-id',
      inicio: 'mañana',
      fin: '',
    });
    expect(malas).toEqual(
      expect.arrayContaining(['espacioId', 'inicio', 'fin']),
    );
  });
});

describe('CrearReservaPortalDto (residente)', () => {
  it('acepta un cuerpo mínimo y uno con inmueble y motivo', async () => {
    expect(await invalidas(CrearReservaPortalDto, base)).toEqual([]);
    expect(
      await invalidas(CrearReservaPortalDto, {
        ...base,
        inmueble: 'A-101',
        motivo: 'x',
      }),
    ).toEqual([]);
  });

  it('exige un espacioId válido y fechas ISO', async () => {
    const malas = await invalidas(CrearReservaPortalDto, {
      espacioId: 'no-id',
      inicio: 'mañana',
      fin: 5,
    });
    expect(malas).toEqual(
      expect.arrayContaining(['espacioId', 'inicio', 'fin']),
    );
  });

  it('el pipe global rechaza con 400 un "residente" enviado por el cliente: el nombre sale de la cuenta', async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

    await expect(
      pipe.transform(
        { ...base, residente: 'Otra Persona' },
        { type: 'body', metatype: CrearReservaPortalDto },
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ActualizarEstadoReservaDto', () => {
  it.each(['aprobada', 'rechazada', 'cancelada'])(
    'acepta %s',
    async (estado) => {
      expect(await invalidas(ActualizarEstadoReservaDto, { estado })).toEqual(
        [],
      );
    },
  );

  it.each(['pendiente', 'approved', 'confirmada', ''])(
    'rechaza %s',
    async (estado) => {
      expect(await invalidas(ActualizarEstadoReservaDto, { estado })).toContain(
        'estado',
      );
    },
  );

  it('rechaza un cuerpo sin estado', async () => {
    expect(await invalidas(ActualizarEstadoReservaDto, {})).toContain('estado');
  });
});

describe('ListarDisponibilidadDto', () => {
  it('acepta una fecha ISO, con o sin hora', async () => {
    expect(
      await invalidas(ListarDisponibilidadDto, { fecha: '2026-09-01' }),
    ).toEqual([]);
    expect(
      await invalidas(ListarDisponibilidadDto, {
        fecha: '2026-09-01T00:00:00.000Z',
      }),
    ).toEqual([]);
  });

  it('rechaza una fecha ausente o inválida (400 en vez de 500)', async () => {
    expect(await invalidas(ListarDisponibilidadDto, {})).toContain('fecha');
    expect(
      await invalidas(ListarDisponibilidadDto, { fecha: 'pasado mañana' }),
    ).toContain('fecha');
  });
});

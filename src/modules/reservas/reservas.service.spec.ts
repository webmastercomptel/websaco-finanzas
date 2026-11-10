import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { relojDeParedBogota } from '../../common/utils/reloj-bogota';
import type { UnidadPortal } from '../portal/portal-acceso.service';
import { MS_POR_HORA, MS_POR_MINUTO } from './reservas-horario';
import { ReservasService } from './reservas.service';

/** A chainable Mongoose query double: every builder step returns itself. */
interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
  sort: jest.Mock;
  populate: jest.Mock;
}

const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.sort = jest.fn().mockReturnValue(q);
  q.populate = jest.fn().mockReturnValue(q);
  return q;
};

type ModeloReservas = jest.Mock & {
  exists: jest.Mock;
  find: jest.Mock;
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
  countDocuments: jest.Mock;
  aggregate: jest.Mock;
};

const COPROPIEDAD = new Types.ObjectId();
const ZONA = new Types.ObjectId();
const RESERVA = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const PERSONAL = new Types.ObjectId();

const AHORA = Date.now();
const enHoras = (h: number) => new Date(AHORA + h * MS_POR_HORA);

const zonaDoc = (extra: Record<string, unknown> = {}) => ({
  _id: ZONA,
  copropiedadId: COPROPIEDAD,
  nombre: 'Salón Social',
  horario: 'Lunes a domingo 08:00 - 20:00',
  requiereReserva: true,
  estado: 'disponible',
  ...extra,
});

const reservaDoc = (extra: Record<string, unknown> = {}) => ({
  _id: RESERVA,
  copropiedadId: COPROPIEDAD,
  zonaId: { _id: ZONA, nombre: 'Salón Social' },
  autorId: CUENTA,
  residente: 'Ana Residente',
  unidad: 'A-101',
  inicio: enHoras(48),
  fin: enHoras(50),
  motivo: null,
  estado: 'pendiente',
  activa: true,
  ...extra,
});

const unidad = (codigo: string): UnidadPortal => ({
  inmuebleId: new Types.ObjectId().toString(),
  codigo,
  rol: 'propietario',
});

const residente = (): IRequestUser => ({
  uid: 'uid-r',
  email: 'r@x.co',
  nombre: 'Ana Residente',
  accountId: CUENTA.toString(),
  esResidente: true,
});

const personal = (): IRequestUser => ({
  uid: 'uid-p',
  email: 'p@x.co',
  nombre: 'Pablo Personal',
  accountId: PERSONAL.toString(),
  permissions: ['reservas.aprobar'],
});

const dtoPortal = (extra: Record<string, unknown> = {}) => ({
  espacioId: ZONA.toString(),
  inicio: enHoras(48).toISOString(),
  fin: enHoras(50).toISOString(),
  ...extra,
});

function montar() {
  const reservas = jest
    .fn()
    .mockImplementation((doc: Record<string, unknown>) => {
      const instancia: Record<string, unknown> = { ...doc, _id: RESERVA };
      instancia.save = jest.fn().mockResolvedValue(instancia);
      return instancia;
    }) as ModeloReservas;
  reservas.exists = jest.fn().mockResolvedValue(null);
  reservas.find = jest.fn().mockReturnValue(consulta([]));
  reservas.findOne = jest.fn().mockReturnValue(consulta(reservaDoc()));
  reservas.findOneAndUpdate = jest.fn().mockReturnValue(consulta(reservaDoc()));
  reservas.countDocuments = jest.fn().mockResolvedValue(0);
  reservas.aggregate = jest.fn().mockReturnValue(consulta([]));

  const zonas = { findOne: jest.fn().mockReturnValue(consulta(zonaDoc())) };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const portalAcceso = {
    unidadesDe: jest
      .fn<Promise<UnidadPortal[]>, [string, string]>()
      .mockResolvedValue([unidad('A-101')]),
  };
  const notificaciones = {
    notificarNueva: jest.fn().mockResolvedValue(undefined),
    notificarRespuesta: jest.fn().mockResolvedValue(undefined),
  };
  const servicio = new ReservasService(
    reservas as never,
    zonas as never,
    tenant as never,
    portalAcceso as never,
    notificaciones as never,
  );
  return { servicio, reservas, zonas, portalAcceso, notificaciones };
}

/** The document the model constructor was called with (what would be persisted). */
const guardado = (reservas: ModeloReservas): Record<string, unknown> =>
  (reservas.mock.calls[0] as [Record<string, unknown>])[0];

describe('ReservasService.crearComoResidente', () => {
  it('guarda una reserva pendiente atada a la cuenta del residente, a su unidad y a su nombre', async () => {
    const { servicio, reservas } = montar();

    await servicio.crearComoResidente(
      dtoPortal({ motivo: 'Cumpleaños' }),
      residente(),
    );

    expect(guardado(reservas)).toMatchObject({
      copropiedadId: COPROPIEDAD,
      zonaId: ZONA,
      autorId: CUENTA,
      residente: 'Ana Residente',
      unidad: 'A-101',
      motivo: 'Cumpleaños',
      estado: 'pendiente',
      activa: true,
    });
  });

  it('guarda las franjas de minuto que cubre la reserva: es lo que usa el índice único contra el doble reservado', async () => {
    const { servicio, reservas } = montar();
    const inicio = new Date(
      Math.ceil((AHORA + 48 * MS_POR_HORA) / MS_POR_MINUTO) * MS_POR_MINUTO,
    );
    const fin = new Date(inicio.getTime() + 2 * MS_POR_HORA);

    await servicio.crearComoResidente(
      dtoPortal({ inicio: inicio.toISOString(), fin: fin.toISOString() }),
      residente(),
    );

    const franjas = guardado(reservas).franjas as number[];
    expect(franjas).toHaveLength(120);
    expect(franjas[0]).toBe(inicio.getTime() / MS_POR_MINUTO);
  });

  it('busca la unidad entre las que el residente realmente tiene, en la copropiedad activa', async () => {
    const { servicio, portalAcceso } = montar();

    await servicio.crearComoResidente(dtoPortal(), residente());

    expect(portalAcceso.unidadesDe).toHaveBeenCalledWith(
      CUENTA.toString(),
      COPROPIEDAD.toString(),
    );
  });

  it('un residente NO puede reservar a nombre de una unidad que no es suya: 403 y no se escribe nada', async () => {
    const { servicio, reservas } = montar();

    await expect(
      servicio.crearComoResidente(
        dtoPortal({ inmueble: 'Z-999' }),
        residente(),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(reservas).not.toHaveBeenCalled();
  });

  it('acepta indicar la unidad sin importar mayúsculas y usa el código de la unidad real', async () => {
    const { servicio, reservas, portalAcceso } = montar();
    portalAcceso.unidadesDe.mockResolvedValue([
      unidad('A-101'),
      unidad('B-202'),
    ]);

    await servicio.crearComoResidente(
      dtoPortal({ inmueble: 'b-202' }),
      residente(),
    );

    expect(guardado(reservas).unidad).toBe('B-202');
  });

  it('con varias unidades exige indicar cuál; con ninguna, avisa que no tiene', async () => {
    const { servicio, portalAcceso, reservas } = montar();
    portalAcceso.unidadesDe.mockResolvedValue([
      unidad('A-101'),
      unidad('B-202'),
    ]);
    await expect(
      servicio.crearComoResidente(dtoPortal(), residente()),
    ).rejects.toThrow(BadRequestException);

    portalAcceso.unidadesDe.mockResolvedValue([]);
    await expect(
      servicio.crearComoResidente(dtoPortal(), residente()),
    ).rejects.toThrow(/No tenés inmuebles/);
    expect(reservas).not.toHaveBeenCalled();
  });

  it('sin cuenta en el token se rechaza con 403, nunca se trata como "cualquiera"', async () => {
    const { servicio, zonas } = montar();

    await expect(
      servicio.crearComoResidente(dtoPortal(), {
        ...residente(),
        accountId: undefined,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(zonas.findOne).not.toHaveBeenCalled();
  });

  it('el espacio se busca por id Y copropiedad: uno de otra copropiedad es un 404', async () => {
    const { servicio, zonas, reservas } = montar();
    zonas.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.crearComoResidente(dtoPortal(), residente()),
    ).rejects.toThrow(NotFoundException);
    expect(zonas.findOne).toHaveBeenCalledWith({
      _id: ZONA.toString(),
      copropiedadId: COPROPIEDAD,
    });
    expect(reservas).not.toHaveBeenCalled();
  });

  it('un espacioId mal formado es un 404 y no toca la base', async () => {
    const { servicio, zonas } = montar();

    await expect(
      servicio.crearComoResidente(dtoPortal({ espacioId: 'xx' }), residente()),
    ).rejects.toThrow(NotFoundException);
    expect(zonas.findOne).not.toHaveBeenCalled();
  });

  describe('reglas del intervalo', () => {
    it('el inicio debe ser anterior al fin', async () => {
      const { servicio, reservas } = montar();

      await expect(
        servicio.crearComoResidente(
          dtoPortal({
            inicio: enHoras(50).toISOString(),
            fin: enHoras(48).toISOString(),
          }),
          residente(),
        ),
      ).rejects.toThrow('La hora de inicio debe ser anterior a la de fin');
      expect(reservas).not.toHaveBeenCalled();
    });

    it('no puede durar más de 24 horas', async () => {
      const { servicio } = montar();

      await expect(
        servicio.crearComoResidente(
          dtoPortal({
            inicio: enHoras(48).toISOString(),
            fin: enHoras(73).toISOString(),
          }),
          residente(),
        ),
      ).rejects.toThrow('24 horas');
    });

    it('dura exactamente 24 horas: se acepta', async () => {
      const { servicio } = montar();

      await expect(
        servicio.crearComoResidente(
          dtoPortal({
            inicio: enHoras(48).toISOString(),
            fin: enHoras(72).toISOString(),
          }),
          residente(),
        ),
      ).resolves.toBeDefined();
    });

    it('un residente no puede pedir una reserva que ya empezó', async () => {
      const { servicio, reservas } = montar();

      // One hour ago on the Bogotá wall clock (the scale bookings are stored in).
      const pared = relojDeParedBogota().getTime();
      await expect(
        servicio.crearComoResidente(
          dtoPortal({
            inicio: new Date(pared - MS_POR_HORA).toISOString(),
            fin: new Date(pared + MS_POR_HORA).toISOString(),
          }),
          residente(),
        ),
      ).rejects.toThrow('futuro');
      expect(reservas).not.toHaveBeenCalled();
    });

    it('fechas imposibles que pasan el formato ISO se rechazan con 400', async () => {
      const { servicio } = montar();

      await expect(
        servicio.crearComoResidente(
          dtoPortal({ inicio: '2026-13-45T10:00:00.000Z' }),
          residente(),
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('qué zonas se pueden reservar', () => {
    it.each([
      ['no requiere reserva', { requiereReserva: false }],
      ['está en mantenimiento', { estado: 'mantenimiento' }],
      ['está cerrada', { estado: 'cerrada' }],
    ])('un residente no puede reservar una zona que %s', async (_n, cambio) => {
      const { servicio, zonas, reservas } = montar();
      zonas.findOne.mockReturnValue(consulta(zonaDoc(cambio)));

      await expect(
        servicio.crearComoResidente(dtoPortal(), residente()),
      ).rejects.toThrow('no está disponible para reservar');
      expect(reservas).not.toHaveBeenCalled();
    });

    it('una zona "ocupada" sí se puede pedir: el original solo bloquea mantenimiento', async () => {
      const { servicio, zonas } = montar();
      zonas.findOne.mockReturnValue(consulta(zonaDoc({ estado: 'ocupada' })));

      await expect(
        servicio.crearComoResidente(dtoPortal(), residente()),
      ).resolves.toBeDefined();
    });
  });

  describe('una sola reserva activa por espacio', () => {
    it('cuenta las pendientes o aprobadas del MISMO residente en ESA zona que no terminaron', async () => {
      const { servicio, reservas } = montar();

      await servicio.crearComoResidente(dtoPortal(), residente());

      const [filtro] = reservas.countDocuments.mock.calls[0] as [
        {
          copropiedadId: Types.ObjectId;
          autorId: Types.ObjectId;
          zonaId: Types.ObjectId;
          estado: { $in: string[] };
          fin: { $gt: Date };
        },
      ];
      expect(filtro.copropiedadId).toBe(COPROPIEDAD);
      expect(filtro.autorId).toEqual(CUENTA);
      expect(filtro.zonaId).toBe(ZONA);
      expect(filtro.estado).toEqual({ $in: ['pendiente', 'aprobada'] });
      expect(filtro.fin.$gt).toBeInstanceOf(Date);
    });

    it('si ya tiene una activa, 400 y no se guarda otra', async () => {
      const { servicio, reservas } = montar();
      reservas.countDocuments.mockResolvedValue(1);

      await expect(
        servicio.crearComoResidente(dtoPortal(), residente()),
      ).rejects.toThrow('Ya tenés una reserva activa para este espacio');
      expect(reservas).not.toHaveBeenCalled();
    });
  });

  describe('choques de horario', () => {
    it('lee los solapes contra pendientes y aprobadas de esa zona y copropiedad, con la fórmula inicio < fin y fin > inicio', async () => {
      const { servicio, reservas } = montar();
      const dto = dtoPortal();

      await servicio.crearComoResidente(dto, residente());

      expect(reservas.exists).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD,
        zonaId: ZONA,
        estado: { $in: ['pendiente', 'aprobada'] },
        inicio: { $lt: new Date(dto.fin) },
        fin: { $gt: new Date(dto.inicio) },
      });
    });

    it('si ya hay una reserva que se solapa, 409 y no se guarda', async () => {
      const { servicio, reservas, notificaciones } = montar();
      reservas.exists.mockResolvedValue({ _id: new Types.ObjectId() });

      await expect(
        servicio.crearComoResidente(dtoPortal(), residente()),
      ).rejects.toThrow(ConflictException);
      expect(reservas).not.toHaveBeenCalled();
      expect(notificaciones.notificarNueva).not.toHaveBeenCalled();
    });

    // El camino a prueba de carreras: dos pedidos del mismo horario pasan la
    // lectura a la vez; el índice único (zonaId, franjas) deja pasar uno solo.
    it('si el índice único rechaza el insert (carrera entre dos pedidos), también es 409 y no se avisa a nadie', async () => {
      const { servicio, reservas, notificaciones } = montar();
      reservas.mockImplementation((doc: Record<string, unknown>) => ({
        ...doc,
        _id: RESERVA,
        save: jest
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
          ),
      }));

      await expect(
        servicio.crearComoResidente(dtoPortal(), residente()),
      ).rejects.toThrow('El espacio ya está reservado en ese horario');
      expect(notificaciones.notificarNueva).not.toHaveBeenCalled();
    });

    it('un error de base de datos que no es de clave duplicada se propaga tal cual', async () => {
      const { servicio, reservas } = montar();
      reservas.mockImplementation(() => ({
        save: jest.fn().mockRejectedValue(new Error('mongo caído')),
      }));

      await expect(
        servicio.crearComoResidente(dtoPortal(), residente()),
      ).rejects.toThrow('mongo caído');
    });
  });

  it('tras guardar avisa al personal con el nombre del espacio, sin excluir a nadie (el residente no es personal)', async () => {
    const { servicio, notificaciones } = montar();

    await servicio.crearComoResidente(dtoPortal(), residente());

    expect(notificaciones.notificarNueva).toHaveBeenCalledWith(
      expect.objectContaining({ _id: RESERVA }),
      'Salón Social',
      COPROPIEDAD,
      undefined,
    );
  });

  it('devuelve el contrato con el nombre del espacio releído (poblado y dentro de la copropiedad)', async () => {
    const { servicio, reservas } = montar();

    const resultado = await servicio.crearComoResidente(
      dtoPortal(),
      residente(),
    );

    expect(resultado).toMatchObject({
      id: RESERVA.toString(),
      espacio: 'Salón Social',
      estado: 'pendiente_aprobacion',
    });
    const [filtro] = reservas.findOne.mock.calls[0] as [
      Record<string, unknown>,
    ];
    expect(filtro).toEqual({ _id: RESERVA, copropiedadId: COPROPIEDAD });
  });
});

describe('ReservasService.crearComoPersonal', () => {
  const dto = (extra: Record<string, unknown> = {}) => ({
    ...dtoPortal(),
    residente: 'Juan Sin Cuenta',
    inmueble: 'Torre 9',
    ...extra,
  });

  it('guarda una reserva pendiente SIN cuenta autora, con el texto libre que escribió el personal', async () => {
    const { servicio, reservas, portalAcceso } = montar();

    await servicio.crearComoPersonal(dto({ motivo: 'Reunión' }), personal());

    expect(guardado(reservas)).toMatchObject({
      copropiedadId: COPROPIEDAD,
      zonaId: ZONA,
      autorId: null,
      residente: 'Juan Sin Cuenta',
      unidad: 'Torre 9',
      motivo: 'Reunión',
      estado: 'pendiente',
      activa: true,
    });
    expect(portalAcceso.unidadesDe).not.toHaveBeenCalled();
  });

  it('no aplica los límites del residente: ni "una activa por espacio" ni "debe ser futura"', async () => {
    const { servicio, reservas } = montar();

    await servicio.crearComoPersonal(
      dto({
        inicio: enHoras(-3).toISOString(),
        fin: enHoras(-1).toISOString(),
      }),
      personal(),
    );

    expect(reservas.countDocuments).not.toHaveBeenCalled();
    expect(reservas).toHaveBeenCalled();
  });

  it('el integrante del personal que la registró no se avisa a sí mismo', async () => {
    const { servicio, notificaciones } = montar();

    await servicio.crearComoPersonal(dto(), personal());

    expect(notificaciones.notificarNueva).toHaveBeenCalledWith(
      expect.anything(),
      'Salón Social',
      COPROPIEDAD,
      PERSONAL.toString(),
    );
  });

  it('respeta las mismas reglas de choque: solape 409 y carrera 409', async () => {
    const { servicio, reservas } = montar();
    reservas.exists.mockResolvedValue({ _id: new Types.ObjectId() });
    await expect(servicio.crearComoPersonal(dto(), personal())).rejects.toThrow(
      ConflictException,
    );

    reservas.exists.mockResolvedValue(null);
    reservas.mockImplementation(() => ({
      save: jest.fn().mockRejectedValue({ code: 11000 }),
    }));
    await expect(servicio.crearComoPersonal(dto(), personal())).rejects.toThrow(
      ConflictException,
    );
  });

  it('el espacio sigue siendo de la copropiedad activa', async () => {
    const { servicio, zonas } = montar();
    zonas.findOne.mockReturnValue(consulta(null));

    await expect(servicio.crearComoPersonal(dto(), personal())).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ReservasService — lecturas del personal', () => {
  it('listar trae todas las de la copropiedad, la más reciente primero, con el nombre del espacio poblado dentro del tenant', async () => {
    const { servicio, reservas } = montar();
    const q = consulta([reservaDoc()]);
    reservas.find.mockReturnValue(q);

    const lista = await servicio.listar();

    expect(reservas.find).toHaveBeenCalledWith({ copropiedadId: COPROPIEDAD });
    expect(q.sort).toHaveBeenCalledWith({ inicio: -1 });
    expect(q.populate).toHaveBeenCalledWith({
      path: 'zonaId',
      select: 'nombre',
      match: { copropiedadId: COPROPIEDAD },
    });
    expect(lista[0].espacio).toBe('Salón Social');
  });

  it('la cola trae pendientes, aprobadas y rechazadas, la más próxima primero', async () => {
    const { servicio, reservas } = montar();
    const q = consulta([reservaDoc()]);
    reservas.find.mockReturnValue(q);

    const cola = await servicio.listarSolicitudes();

    expect(reservas.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      estado: { $in: ['pendiente', 'aprobada', 'rechazada'] },
    });
    expect(q.sort).toHaveBeenCalledWith({ inicio: 1 });
    expect(cola[0].area).toBe('Salón Social');
  });

  describe('estadisticas', () => {
    it('cuenta las pendientes, las de hoy (confirmadas y en curso) y el área más pedida', async () => {
      const { servicio, reservas, zonas } = montar();
      const ahora = relojDeParedBogota();
      reservas.countDocuments.mockImplementation(
        (filtro: { estado?: string }) =>
          Promise.resolve(filtro.estado === 'pendiente' ? 4 : 10),
      );
      reservas.find.mockReturnValue(
        consulta([
          {
            estado: 'aprobada',
            inicio: new Date(ahora.getTime() - MS_POR_HORA),
            fin: new Date(ahora.getTime() + MS_POR_HORA),
          },
          {
            estado: 'pendiente',
            inicio: new Date(ahora.getTime() + MS_POR_HORA),
            fin: new Date(ahora.getTime() + 2 * MS_POR_HORA),
          },
        ]),
      );
      reservas.aggregate.mockReturnValue(consulta([{ _id: ZONA, n: 5 }]));
      zonas.findOne.mockReturnValue(consulta({ nombre: 'Gimnasio' }));

      const resultado = await servicio.estadisticas();

      expect(resultado).toEqual({
        solicitudesPendientes: 4,
        reservasHoy: { total: 2, confirmadas: 1, enCurso: 1 },
        areaMasDemandada: { nombre: 'Gimnasio', porcentaje: 50 },
      });
    });

    it('todo se calcula dentro de la copropiedad, también el nombre del área', async () => {
      const { servicio, reservas, zonas } = montar();
      reservas.aggregate.mockReturnValue(consulta([{ _id: ZONA, n: 1 }]));

      await servicio.estadisticas();

      const [etapas] = reservas.aggregate.mock.calls[0] as [
        Array<Record<string, unknown>>,
      ];
      expect(etapas[0]).toEqual({ $match: { copropiedadId: COPROPIEDAD } });
      expect(zonas.findOne).toHaveBeenCalledWith({
        _id: ZONA,
        copropiedadId: COPROPIEDAD,
      });
    });

    it('sin reservas: área "—" y 0 %, sin buscar ninguna zona', async () => {
      const { servicio, zonas } = montar();

      const resultado = await servicio.estadisticas();

      expect(resultado.areaMasDemandada).toEqual({
        nombre: '—',
        porcentaje: 0,
      });
      expect(zonas.findOne).not.toHaveBeenCalled();
    });
  });

  describe('disponibilidad', () => {
    it('devuelve el horario del texto de la zona y lo ocupado ese día en UTC', async () => {
      const { servicio, reservas } = montar();
      const q = consulta([
        {
          inicio: new Date('2026-09-01T14:00:00.000Z'),
          fin: new Date('2026-09-01T16:30:00.000Z'),
        },
      ]);
      reservas.find.mockReturnValue(q);

      const resultado = await servicio.disponibilidad(
        ZONA.toString(),
        '2026-09-01T09:30:00.000Z',
      );

      expect(resultado).toEqual({
        horarioOperacion: { inicio: '08:00', fin: '20:00' },
        ocupados: [{ inicio: '14:00', fin: '16:30' }],
      });
      expect(reservas.find).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD,
        zonaId: ZONA,
        estado: { $in: ['pendiente', 'aprobada'] },
        inicio: {
          $gte: new Date('2026-09-01T00:00:00.000Z'),
          $lt: new Date('2026-09-02T00:00:00.000Z'),
        },
      });
    });

    it('una zona de otra copropiedad es un 404', async () => {
      const { servicio, zonas } = montar();
      zonas.findOne.mockReturnValue(consulta(null));

      await expect(
        servicio.disponibilidad(ZONA.toString(), '2026-09-01'),
      ).rejects.toThrow(NotFoundException);
    });

    it('una fecha imposible es un 400, no un cast error de Mongo', async () => {
      const { servicio } = montar();

      await expect(
        servicio.disponibilidad(ZONA.toString(), '2026-13-45'),
      ).rejects.toThrow(BadRequestException);
    });
  });
});

describe('ReservasService.cambiarEstado (personal)', () => {
  it.each([
    ['aprobada', true],
    ['rechazada', false],
    ['cancelada', false],
  ] as const)(
    'pasar a %s es UN update atómico de estado y activa=%s, filtrado por id Y copropiedad',
    async (estado, activa) => {
      const { servicio, reservas } = montar();

      await servicio.cambiarEstado(RESERVA.toString(), { estado }, personal());

      expect(reservas.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: RESERVA.toString(),
          copropiedadId: COPROPIEDAD,
          estado: { $ne: estado },
        },
        { $set: { estado, activa } },
        { new: true },
      );
    },
  );

  it.each(['aprobada', 'rechazada', 'cancelada'] as const)(
    'al %s avisa a quien la pidió, con el actor para no avisarle de lo que hizo él',
    async (estado) => {
      const { servicio, notificaciones } = montar();

      await servicio.cambiarEstado(RESERVA.toString(), { estado }, personal());

      expect(notificaciones.notificarRespuesta).toHaveBeenCalledWith(
        expect.objectContaining({ _id: RESERVA }),
        'Salón Social',
        COPROPIEDAD,
        estado,
        PERSONAL.toString(),
      );
    },
  );

  it('devuelve el contrato con el estado visible (aprobada se ve confirmada)', async () => {
    const { servicio, reservas } = montar();
    reservas.findOneAndUpdate.mockReturnValue(
      consulta(reservaDoc({ estado: 'aprobada' })),
    );

    const resultado = await servicio.cambiarEstado(
      RESERVA.toString(),
      { estado: 'aprobada' },
      personal(),
    );

    expect(resultado.estado).toBe('confirmada');
  });

  it('una reserva de otra copropiedad (o inexistente) es un 404 y no se avisa a nadie', async () => {
    const { servicio, reservas, notificaciones } = montar();
    reservas.findOneAndUpdate.mockReturnValue(consulta(null));
    reservas.findOne.mockReturnValue(consulta(null));

    await expect(
      servicio.cambiarEstado(
        RESERVA.toString(),
        { estado: 'aprobada' },
        personal(),
      ),
    ).rejects.toThrow(NotFoundException);
    expect(notificaciones.notificarRespuesta).not.toHaveBeenCalled();
  });

  it('un id mal formado es un 404 y no toca la base', async () => {
    const { servicio, reservas } = montar();

    await expect(
      servicio.cambiarEstado('xx', { estado: 'aprobada' }, personal()),
    ).rejects.toThrow(NotFoundException);
    expect(reservas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('si ya estaba en ese estado (doble clic) responde el estado actual y NO repite el correo', async () => {
    const { servicio, reservas, notificaciones } = montar();
    reservas.findOneAndUpdate.mockReturnValue(consulta(null));
    reservas.findOne.mockReturnValue(
      consulta(reservaDoc({ estado: 'aprobada' })),
    );

    const resultado = await servicio.cambiarEstado(
      RESERVA.toString(),
      { estado: 'aprobada' },
      personal(),
    );

    expect(resultado.estado).toBe('confirmada');
    expect(notificaciones.notificarRespuesta).not.toHaveBeenCalled();
  });

  it('reactivar una reserva rechazada cuyo horario ya tomó otra choca con el índice único: 409', async () => {
    const { servicio, reservas, notificaciones } = montar();
    reservas.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        exec: jest.fn().mockRejectedValue({ code: 11000 }),
      }),
    });

    await expect(
      servicio.cambiarEstado(
        RESERVA.toString(),
        { estado: 'aprobada' },
        personal(),
      ),
    ).rejects.toThrow(ConflictException);
    expect(notificaciones.notificarRespuesta).not.toHaveBeenCalled();
  });
});

describe('ReservasService — reservas propias del residente', () => {
  it('listarPropias filtra por la cuenta del llamante además de la copropiedad', async () => {
    const { servicio, reservas } = montar();
    const q = consulta([reservaDoc()]);
    reservas.find.mockReturnValue(q);

    const lista = await servicio.listarPropias(residente());

    expect(reservas.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      autorId: CUENTA,
    });
    expect(q.sort).toHaveBeenCalledWith({ inicio: -1 });
    expect(lista).toHaveLength(1);
  });

  it('sin cuenta no hay "mis reservas": 403, nunca todas', async () => {
    const { servicio, reservas } = montar();

    await expect(
      servicio.listarPropias({ ...residente(), accountId: undefined }),
    ).rejects.toThrow(ForbiddenException);
    expect(reservas.find).not.toHaveBeenCalled();
  });

  describe('cancelarPropia', () => {
    it('cancela con UN update atómico cuyo filtro lleva id, copropiedad, AUTOR, estado cancelable y la anticipación de 6 horas', async () => {
      const { servicio, reservas } = montar();
      reservas.findOneAndUpdate.mockReturnValue(
        consulta(reservaDoc({ estado: 'cancelada' })),
      );
      const antes = relojDeParedBogota().getTime();

      const resultado = await servicio.cancelarPropia(
        RESERVA.toString(),
        residente(),
      );

      const [filtro, cambio, opciones] = reservas.findOneAndUpdate.mock
        .calls[0] as [
        {
          _id: string;
          copropiedadId: Types.ObjectId;
          autorId: Types.ObjectId;
          estado: { $in: string[] };
          inicio: { $gte: Date };
        },
        unknown,
        unknown,
      ];
      expect(filtro._id).toBe(RESERVA.toString());
      expect(filtro.copropiedadId).toBe(COPROPIEDAD);
      expect(filtro.autorId).toEqual(CUENTA);
      expect(filtro.estado).toEqual({ $in: ['pendiente', 'aprobada'] });
      const limite = filtro.inicio.$gte.getTime();
      expect(limite).toBeGreaterThanOrEqual(antes + 6 * MS_POR_HORA);
      expect(limite).toBeLessThanOrEqual(
        relojDeParedBogota().getTime() + 6 * MS_POR_HORA,
      );
      expect(cambio).toEqual({ $set: { estado: 'cancelada', activa: false } });
      expect(opciones).toEqual({ new: true });
      expect(resultado.estado).toBe('cancelada');
    });

    it('no avisa a nadie: lo canceló el propio residente (el original tampoco)', async () => {
      const { servicio, notificaciones } = montar();

      await servicio.cancelarPropia(RESERVA.toString(), residente());

      expect(notificaciones.notificarNueva).not.toHaveBeenCalled();
      expect(notificaciones.notificarRespuesta).not.toHaveBeenCalled();
    });

    it('la reserva de OTRO residente es un 404, indistinguible de una inexistente', async () => {
      const { servicio, reservas } = montar();
      reservas.findOneAndUpdate.mockReturnValue(consulta(null));
      reservas.findOne.mockReturnValue(consulta(null));

      await expect(
        servicio.cancelarPropia(RESERVA.toString(), residente()),
      ).rejects.toThrow(NotFoundException);
      // El diagnóstico también filtra por autor: nunca confirma que el id existe.
      expect(reservas.findOne).toHaveBeenCalledWith({
        _id: RESERVA.toString(),
        copropiedadId: COPROPIEDAD,
        autorId: CUENTA,
      });
    });

    it.each(['rechazada', 'cancelada'])(
      'una reserva %s ya no se puede cancelar: 400',
      async (estado) => {
        const { servicio, reservas } = montar();
        reservas.findOneAndUpdate.mockReturnValue(consulta(null));
        reservas.findOne.mockReturnValue(consulta({ estado }));

        await expect(
          servicio.cancelarPropia(RESERVA.toString(), residente()),
        ).rejects.toThrow(
          'Solo podés cancelar reservas pendientes o aprobadas',
        );
      },
    );

    it('con menos de 6 horas de anticipación: 400', async () => {
      const { servicio, reservas } = montar();
      reservas.findOneAndUpdate.mockReturnValue(consulta(null));
      reservas.findOne.mockReturnValue(consulta({ estado: 'aprobada' }));

      await expect(
        servicio.cancelarPropia(RESERVA.toString(), residente()),
      ).rejects.toThrow('menos de 6 horas de anticipación');
    });

    it('un id mal formado es un 404 y no toca la base', async () => {
      const { servicio, reservas } = montar();

      await expect(servicio.cancelarPropia('xx', residente())).rejects.toThrow(
        NotFoundException,
      );
      expect(reservas.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('sin cuenta en el token: 403 y no se intenta cancelar', async () => {
      const { servicio, reservas } = montar();

      await expect(
        servicio.cancelarPropia(RESERVA.toString(), {
          ...residente(),
          accountId: undefined,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(reservas.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});

/**
 * Bookings are stored as the Bogotá wall clock written as UTC (21:00 is
 * `T21:00Z`), so every rule against "now" must compare with the wall clock,
 * not the real instant (5 hours ahead). The clock is pinned through
 * `Date.now`, never read from the machine.
 */
describe('ReservasService — reglas contra la hora de Bogotá (reloj de pared)', () => {
  // 16:30 in Bogotá = 21:30 UTC real.
  const AHORA_REAL = Date.parse('2026-09-10T21:30:00.000Z');

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(AHORA_REAL);
  });
  afterEach(() => jest.restoreAllMocks());

  it('una solicitud para hoy a las 21:00 hecha a las 16:30 de Bogotá se ACEPTA (antes se rechazaba)', async () => {
    const { servicio, reservas } = montar();

    await expect(
      servicio.crearComoResidente(
        dtoPortal({
          inicio: '2026-09-10T21:00:00.000Z',
          fin: '2026-09-10T22:00:00.000Z',
        }),
        residente(),
      ),
    ).resolves.toBeDefined();
    expect(reservas).toHaveBeenCalledTimes(1);
  });

  it('una solicitud para hoy a las 16:00 hecha a las 16:30 de Bogotá se rechaza: ya empezó', async () => {
    const { servicio, reservas } = montar();

    await expect(
      servicio.crearComoResidente(
        dtoPortal({
          inicio: '2026-09-10T16:00:00.000Z',
          fin: '2026-09-10T17:00:00.000Z',
        }),
        residente(),
      ),
    ).rejects.toThrow('futuro');
    expect(reservas).not.toHaveBeenCalled();
  });

  it('"una activa por espacio" cuenta las que no terminaron según la hora de Bogotá', async () => {
    const { servicio, reservas } = montar();

    await servicio.crearComoResidente(
      dtoPortal({
        inicio: '2026-09-11T10:00:00.000Z',
        fin: '2026-09-11T11:00:00.000Z',
      }),
      residente(),
    );

    const [filtro] = reservas.countDocuments.mock.calls[0] as [
      { fin: { $gt: Date } },
    ];
    expect(filtro.fin.$gt.toISOString()).toBe('2026-09-10T16:30:00.000Z');
  });

  describe('cancelar con 6 horas de anticipación', () => {
    const limiteDelFiltro = async (): Promise<Date> => {
      const { servicio, reservas } = montar();
      await servicio.cancelarPropia(RESERVA.toString(), residente());
      const [filtro] = reservas.findOneAndUpdate.mock.calls[0] as [
        { inicio: { $gte: Date } },
      ];
      return filtro.inicio.$gte;
    };

    it('el límite es la hora de Bogotá más 6 horas (16:30 → 22:30), no la hora UTC real', async () => {
      expect((await limiteDelFiltro()).toISOString()).toBe(
        '2026-09-10T22:30:00.000Z',
      );
    });

    it('se puede cancelar exactamente 6 horas antes de la hora escrita y NO a 5 h 59 min', async () => {
      const limite = await limiteDelFiltro();
      const aSeisHoras = new Date('2026-09-10T22:30:00.000Z');
      const aCincoHoras59 = new Date('2026-09-10T22:29:00.000Z');

      // The filter is `inicio >= limite`: Mongo applies exactly this comparison.
      expect(aSeisHoras >= limite).toBe(true);
      expect(aCincoHoras59 >= limite).toBe(false);
    });
  });

  describe('estadisticas usan el día y la hora de Bogotá', () => {
    // 22:00 in Bogotá on 9 Sep = 03:00 UTC real on 10 Sep.
    const NOCHE_REAL = Date.parse('2026-09-10T03:00:00.000Z');

    it('"hoy" es el 9 de septiembre de Bogotá aunque en UTC ya sea el 10', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOCHE_REAL);
      const { servicio, reservas } = montar();

      await servicio.estadisticas();

      const [filtro] = reservas.find.mock.calls[0] as [
        { inicio: { $gte: Date; $lt: Date } },
      ];
      expect(filtro.inicio.$gte.toISOString()).toBe('2026-09-09T00:00:00.000Z');
      expect(filtro.inicio.$lt.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    });

    it('"en curso" compara la hora escrita con la hora de Bogotá', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOCHE_REAL);
      const { servicio, reservas } = montar();
      reservas.find.mockReturnValue(
        consulta([
          // 21:00–23:00 typed: happening at 22:00 Bogotá.
          {
            estado: 'aprobada',
            inicio: new Date('2026-09-09T21:00:00.000Z'),
            fin: new Date('2026-09-09T23:00:00.000Z'),
          },
          // 17:00–18:00 typed: already over at 22:00 Bogotá.
          {
            estado: 'aprobada',
            inicio: new Date('2026-09-09T17:00:00.000Z'),
            fin: new Date('2026-09-09T18:00:00.000Z'),
          },
        ]),
      );

      const resultado = await servicio.estadisticas();

      expect(resultado.reservasHoy).toEqual({
        total: 2,
        confirmadas: 2,
        enCurso: 1,
      });
    });
  });
});

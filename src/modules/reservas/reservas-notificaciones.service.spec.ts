import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Destinatario } from '../../common/directorio/directorio.service';
import type { ReservaDocument } from '../../database/schemas/administracion/reserva.schema';
import {
  ENVIOS_SIMULTANEOS,
  ReservasNotificacionesService,
} from './reservas-notificaciones.service';

const COPROPIEDAD = new Types.ObjectId();
const RESERVA = new Types.ObjectId();
const AUTOR = new Types.ObjectId();

const reservaDoc = (extra: Record<string, unknown> = {}): ReservaDocument =>
  ({
    _id: RESERVA,
    copropiedadId: COPROPIEDAD,
    autorId: AUTOR,
    residente: 'Juan Pérez',
    unidad: '501',
    inicio: new Date('2026-09-01T14:00:00.000Z'),
    fin: new Date('2026-09-01T16:00:00.000Z'),
    motivo: 'Cumpleaños',
    estado: 'pendiente',
    ...extra,
  }) as unknown as ReservaDocument;

const destinatario = (
  n: number,
  perfil: Destinatario['perfil'] = 'personal',
  accountId = new Types.ObjectId().toString(),
): Destinatario => ({
  accountId,
  email: `persona${n}@example.com`,
  nombre: `Persona ${n}`,
  perfil,
});

function montar(personal: Destinatario[] = [destinatario(1)]) {
  const copropiedades = {
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ nombre: 'Torres del Parque' }),
      }),
    }),
  };
  const directorio = {
    personalQuePuedeLeer: jest
      .fn<Promise<Destinatario[]>, [Types.ObjectId, string]>()
      .mockResolvedValue(personal),
    destinatarioDe: jest
      .fn<Promise<Destinatario | null>, [string, Types.ObjectId, string]>()
      .mockResolvedValue(null),
  };
  const correo = {
    enviar: jest
      .fn<Promise<boolean>, [{ para: string; asunto: string; html: string }]>()
      .mockResolvedValue(true),
  };
  const enlaces = {
    construir: jest
      .fn<Promise<string | null>, [string, string, string]>()
      .mockImplementation((_cuenta, _copropiedad, destino) =>
        Promise.resolve(`https://app.example.com/auth/enlace?to=${destino}`),
      ),
  };
  const notificaciones = { crear: jest.fn().mockResolvedValue(undefined) };
  const servicio = new ReservasNotificacionesService(
    copropiedades as never,
    directorio as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
  );
  return { servicio, directorio, correo, enlaces, notificaciones };
}

describe('ReservasNotificacionesService.notificarNueva', () => {
  it('pide el personal que puede leer Reserva en la copropiedad de la reserva', async () => {
    const { servicio, directorio } = montar();

    await servicio.notificarNueva(reservaDoc(), 'Salón Social', COPROPIEDAD);

    expect(directorio.personalQuePuedeLeer).toHaveBeenCalledWith(
      COPROPIEDAD,
      'Reserva',
    );
  });

  it('envía un correo a cada integrante del personal, con el botón a /reservas?abrir=<id>', async () => {
    const { servicio, correo, enlaces } = montar([
      destinatario(1),
      destinatario(2),
    ]);

    await servicio.notificarNueva(reservaDoc(), 'Salón Social', COPROPIEDAD);

    expect(correo.enviar).toHaveBeenCalledTimes(2);
    expect(enlaces.construir).toHaveBeenCalledWith(
      expect.any(String),
      COPROPIEDAD.toString(),
      `/reservas?abrir=${RESERVA.toString()}`,
    );
    expect(correo.enviar).toHaveBeenCalledWith({
      para: 'persona1@example.com',
      asunto: 'Nueva reserva pendiente en Torres del Parque: Salón Social',
      html: expect.stringContaining('Salón Social') as string,
    });
  });

  it('crea la entrada en la app, de tipo reserva, para cada integrante notificado', async () => {
    const a = destinatario(1);
    const { servicio, notificaciones } = montar([a]);

    await servicio.notificarNueva(reservaDoc(), 'Salón Social', COPROPIEDAD);

    expect(notificaciones.crear).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      accountId: a.accountId,
      tipo: 'reserva',
      titulo: 'Nueva reserva pendiente en Torres del Parque: Salón Social',
    });
  });

  it('el integrante del personal que la registró no se avisa a sí mismo', async () => {
    const yo = destinatario(1);
    const otro = destinatario(2);
    const { servicio, correo, notificaciones } = montar([yo, otro]);

    await servicio.notificarNueva(
      reservaDoc(),
      'Salón Social',
      COPROPIEDAD,
      yo.accountId,
    );

    expect(correo.enviar).toHaveBeenCalledTimes(1);
    expect(correo.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ para: otro.email }),
    );
    expect(notificaciones.crear).toHaveBeenCalledTimes(1);
  });

  it('si no queda nadie a quien avisar no envía nada', async () => {
    const yo = destinatario(1);
    const { servicio, correo, notificaciones } = montar([yo]);

    await servicio.notificarNueva(
      reservaDoc(),
      'Salón Social',
      COPROPIEDAD,
      yo.accountId,
    );

    expect(correo.enviar).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
  });

  it('manda en tandas de a lo sumo ENVIOS_SIMULTANEOS a la vez', async () => {
    const personal = Array.from(
      { length: ENVIOS_SIMULTANEOS * 2 + 3 },
      (_, i) => destinatario(i),
    );
    const { servicio, correo } = montar(personal);
    let enVuelo = 0;
    let maximo = 0;
    correo.enviar.mockImplementation(async () => {
      enVuelo += 1;
      maximo = Math.max(maximo, enVuelo);
      await new Promise((resolve) => setImmediate(resolve));
      enVuelo -= 1;
      return true;
    });

    await servicio.notificarNueva(reservaDoc(), 'Salón Social', COPROPIEDAD);

    expect(correo.enviar).toHaveBeenCalledTimes(personal.length);
    expect(maximo).toBeLessThanOrEqual(ENVIOS_SIMULTANEOS);
  });

  describe('nunca lanza', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('un fallo del directorio se registra y se traga', async () => {
      const { servicio, directorio } = montar();
      directorio.personalQuePuedeLeer.mockRejectedValue(new Error('caído'));

      await expect(
        servicio.notificarNueva(reservaDoc(), 'Salón Social', COPROPIEDAD),
      ).resolves.toBeUndefined();
    });

    it('un destinatario que falla no impide avisar a los demás', async () => {
      const { servicio, correo, notificaciones } = montar([
        destinatario(1),
        destinatario(2),
      ]);
      correo.enviar
        .mockRejectedValueOnce(new Error('smtp'))
        .mockResolvedValue(true);

      await expect(
        servicio.notificarNueva(reservaDoc(), 'Salón Social', COPROPIEDAD),
      ).resolves.toBeUndefined();
      expect(correo.enviar).toHaveBeenCalledTimes(2);
      expect(notificaciones.crear).toHaveBeenCalledTimes(1);
    });

    it('si el correo no se pudo enviar igual deja la entrada en la app', async () => {
      const { servicio, correo, notificaciones } = montar();
      correo.enviar.mockResolvedValue(false);

      await servicio.notificarNueva(reservaDoc(), 'Salón Social', COPROPIEDAD);

      expect(notificaciones.crear).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ReservasNotificacionesService.notificarRespuesta', () => {
  it('avisa a quien la pidió por el directorio, con la materia Reserva', async () => {
    const { servicio, directorio } = montar();

    await servicio.notificarRespuesta(
      reservaDoc(),
      'Salón Social',
      COPROPIEDAD,
      'aprobada',
    );

    expect(directorio.destinatarioDe).toHaveBeenCalledWith(
      AUTOR.toString(),
      COPROPIEDAD,
      'Reserva',
    );
  });

  it.each([
    ['aprobada', 'Tu reserva de Salón Social fue aprobada'],
    ['rechazada', 'Tu reserva de Salón Social fue rechazada'],
    ['cancelada', 'Tu reserva de Salón Social fue cancelada'],
  ] as const)(
    'al %s la reserva manda correo y entrada en la app al residente',
    async (respuesta, asunto) => {
      const residente = destinatario(1, 'residente', AUTOR.toString());
      const { servicio, directorio, correo, notificaciones } = montar();
      directorio.destinatarioDe.mockResolvedValue(residente);

      await servicio.notificarRespuesta(
        reservaDoc(),
        'Salón Social',
        COPROPIEDAD,
        respuesta,
        new Types.ObjectId().toString(),
      );

      expect(correo.enviar).toHaveBeenCalledWith({
        para: residente.email,
        asunto,
        html: expect.any(String) as string,
      });
      expect(notificaciones.crear).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD,
        accountId: residente.accountId,
        tipo: 'reserva',
        titulo: asunto,
      });
    },
  );

  it('un residente recibe el enlace al portal: /portal/reservas?abrir=<id>', async () => {
    const { servicio, directorio, enlaces } = montar();
    directorio.destinatarioDe.mockResolvedValue(
      destinatario(1, 'residente', AUTOR.toString()),
    );

    await servicio.notificarRespuesta(
      reservaDoc(),
      'Salón Social',
      COPROPIEDAD,
      'aprobada',
    );

    expect(enlaces.construir).toHaveBeenCalledWith(
      AUTOR.toString(),
      COPROPIEDAD.toString(),
      `/portal/reservas?abrir=${RESERVA.toString()}`,
    );
  });

  it('un autor del personal recibe el enlace del back-office: /reservas?abrir=<id>', async () => {
    const { servicio, directorio, enlaces } = montar();
    directorio.destinatarioDe.mockResolvedValue(
      destinatario(1, 'personal', AUTOR.toString()),
    );

    await servicio.notificarRespuesta(
      reservaDoc(),
      'Salón Social',
      COPROPIEDAD,
      'rechazada',
    );

    expect(enlaces.construir).toHaveBeenCalledWith(
      AUTOR.toString(),
      COPROPIEDAD.toString(),
      `/reservas?abrir=${RESERVA.toString()}`,
    );
  });

  it('no avisa si quien actuó es el propio autor', async () => {
    const { servicio, directorio, correo } = montar();

    await servicio.notificarRespuesta(
      reservaDoc(),
      'Salón Social',
      COPROPIEDAD,
      'cancelada',
      AUTOR.toString(),
    );

    expect(directorio.destinatarioDe).not.toHaveBeenCalled();
    expect(correo.enviar).not.toHaveBeenCalled();
  });

  it('no avisa si la reserva no tiene cuenta autora (la registró el personal)', async () => {
    const { servicio, directorio, correo } = montar();

    await servicio.notificarRespuesta(
      reservaDoc({ autorId: null }),
      'Salón Social',
      COPROPIEDAD,
      'aprobada',
    );

    expect(directorio.destinatarioDe).not.toHaveBeenCalled();
    expect(correo.enviar).not.toHaveBeenCalled();
  });

  it('no avisa si el autor ya no es alcanzable (el directorio devuelve null)', async () => {
    const { servicio, correo, notificaciones } = montar();

    await servicio.notificarRespuesta(
      reservaDoc(),
      'Salón Social',
      COPROPIEDAD,
      'aprobada',
    );

    expect(correo.enviar).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo del directorio se registra y se traga', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { servicio, directorio } = montar();
    directorio.destinatarioDe.mockRejectedValue(new Error('caído'));

    await expect(
      servicio.notificarRespuesta(
        reservaDoc(),
        'Salón Social',
        COPROPIEDAD,
        'aprobada',
      ),
    ).resolves.toBeUndefined();
    jest.restoreAllMocks();
  });
});

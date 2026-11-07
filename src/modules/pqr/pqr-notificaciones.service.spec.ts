import { Types } from 'mongoose';
import type { Destinatario } from '../../common/directorio/directorio.service';
import type { PqrDocument } from '../../database/schemas/administracion/pqr.schema';
import {
  ENVIOS_SIMULTANEOS,
  PqrNotificacionesService,
} from './pqr-notificaciones.service';

const COPROPIEDAD = new Types.ObjectId();
const PQR = new Types.ObjectId();
const AUTOR = new Types.ObjectId();

const pqrDoc = (extra: Record<string, unknown> = {}): PqrDocument =>
  ({
    _id: PQR,
    codigo: 'PQR-001',
    titulo: 'Filtración',
    descripcion: 'Hay una filtración',
    descripcionCompleta: '',
    tipo: 'reclamos',
    prioridad: 'normal',
    unidad: 'A-101',
    residente: { nombre: 'Juan Pérez', rol: 'Propietario' },
    autorId: AUTOR,
    ...extra,
  }) as unknown as PqrDocument;

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
  const notificaciones = {
    crear: jest.fn().mockResolvedValue(undefined),
  };
  const servicio = new PqrNotificacionesService(
    copropiedades as never,
    directorio as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
  );
  return { servicio, directorio, correo, enlaces, notificaciones };
}

describe('PqrNotificacionesService.notificarNueva', () => {
  it('pide el personal que puede leer Pqr en la copropiedad de la PQR', async () => {
    const { servicio, directorio } = montar();

    await servicio.notificarNueva(pqrDoc(), COPROPIEDAD);

    expect(directorio.personalQuePuedeLeer).toHaveBeenCalledWith(
      COPROPIEDAD,
      'Pqr',
    );
  });

  it('envía un correo a cada integrante del personal, con el botón a /pqr?abrir=<id>', async () => {
    const { servicio, correo, enlaces } = montar([
      destinatario(1),
      destinatario(2),
    ]);

    await servicio.notificarNueva(pqrDoc(), COPROPIEDAD);

    expect(correo.enviar).toHaveBeenCalledTimes(2);
    expect(enlaces.construir).toHaveBeenCalledWith(
      expect.any(String),
      COPROPIEDAD.toString(),
      `/pqr?abrir=${PQR.toString()}`,
    );
    expect(correo.enviar).toHaveBeenCalledWith({
      para: 'persona1@example.com',
      asunto: 'Nueva PQR en Torres del Parque: PQR-001',
      html: expect.stringContaining('Filtración') as string,
    });
  });

  it('crea la entrada en la app, de tipo pqr, para cada integrante notificado', async () => {
    const a = destinatario(1);
    const { servicio, notificaciones } = montar([a]);

    await servicio.notificarNueva(pqrDoc(), COPROPIEDAD);

    expect(notificaciones.crear).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      accountId: a.accountId,
      tipo: 'pqr',
      titulo: 'Nueva PQR en Torres del Parque: PQR-001',
    });
  });

  it('quien la registró no se avisa a sí mismo', async () => {
    const yo = destinatario(1);
    const otro = destinatario(2);
    const { servicio, correo, notificaciones } = montar([yo, otro]);

    await servicio.notificarNueva(pqrDoc(), COPROPIEDAD, yo.accountId);

    expect(correo.enviar).toHaveBeenCalledTimes(1);
    expect(correo.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ para: otro.email }),
    );
    expect(notificaciones.crear).toHaveBeenCalledTimes(1);
  });

  it('el personal que no puede leer Pqr no está en el directorio y por tanto no recibe nada', async () => {
    const { servicio, correo, enlaces, notificaciones } = montar([]);

    await servicio.notificarNueva(pqrDoc(), COPROPIEDAD);

    expect(correo.enviar).not.toHaveBeenCalled();
    expect(enlaces.construir).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
  });

  it('si no se puede emitir enlace, el correo sale igual pero sin botón', async () => {
    const { servicio, correo, enlaces } = montar();
    enlaces.construir.mockResolvedValue(null);

    await servicio.notificarNueva(pqrDoc(), COPROPIEDAD);

    const { html } = correo.enviar.mock.calls[0][0];
    expect(html).not.toContain('Ver la PQR');
  });

  it('un correo que falla (false) no corta el aviso en la app de esa persona', async () => {
    const { servicio, correo, notificaciones } = montar();
    correo.enviar.mockResolvedValue(false);

    await servicio.notificarNueva(pqrDoc(), COPROPIEDAD);

    expect(notificaciones.crear).toHaveBeenCalledTimes(1);
  });

  it('un envío que revienta no detiene a los demás ni lanza', async () => {
    const { servicio, correo, notificaciones } = montar([
      destinatario(1),
      destinatario(2),
      destinatario(3),
    ]);
    correo.enviar.mockRejectedValueOnce(new Error('SendGrid caído'));

    await expect(
      servicio.notificarNueva(pqrDoc(), COPROPIEDAD),
    ).resolves.toBeUndefined();
    expect(correo.enviar).toHaveBeenCalledTimes(3);
    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
  });

  it('un fallo al consultar el directorio no lanza', async () => {
    const { servicio, directorio, correo } = montar();
    directorio.personalQuePuedeLeer.mockRejectedValue(new Error('mongo'));

    await expect(
      servicio.notificarNueva(pqrDoc(), COPROPIEDAD),
    ).resolves.toBeUndefined();
    expect(correo.enviar).not.toHaveBeenCalled();
  });

  it('nunca hay más de 10 envíos en vuelo y todo el personal se procesa', async () => {
    const personal = Array.from({ length: 25 }, (_, i) => destinatario(i));
    const { servicio, correo } = montar(personal);
    let enVuelo = 0;
    let maximo = 0;
    correo.enviar.mockImplementation(async () => {
      enVuelo++;
      maximo = Math.max(maximo, enVuelo);
      await new Promise((resolve) => setImmediate(resolve));
      enVuelo--;
      return true;
    });

    await servicio.notificarNueva(pqrDoc(), COPROPIEDAD);

    expect(correo.enviar).toHaveBeenCalledTimes(25);
    expect(maximo).toBeLessThanOrEqual(ENVIOS_SIMULTANEOS);
    expect(maximo).toBeGreaterThan(1);
  });
});

describe('PqrNotificacionesService.notificarRespuesta', () => {
  const escritor = {
    accountId: new Types.ObjectId().toString(),
    nombre: 'Ana',
  };

  it('a una autora residente le llega el enlace al portal: /portal/pqr?abrir=<id>', async () => {
    const autora = destinatario(1, 'residente', AUTOR.toString());
    const { servicio, directorio, enlaces, correo } = montar();
    directorio.destinatarioDe.mockResolvedValue(autora);

    await servicio.notificarRespuesta(
      pqrDoc(),
      COPROPIEDAD,
      escritor,
      'Ya enviamos un técnico.',
    );

    expect(directorio.destinatarioDe).toHaveBeenCalledWith(
      AUTOR.toString(),
      COPROPIEDAD,
      'Pqr',
    );
    expect(enlaces.construir).toHaveBeenCalledWith(
      AUTOR.toString(),
      COPROPIEDAD.toString(),
      `/portal/pqr?abrir=${PQR.toString()}`,
    );
    expect(correo.enviar).toHaveBeenCalledWith({
      para: autora.email,
      asunto: 'Nueva respuesta en tu PQR PQR-001',
      html: expect.stringContaining('Ya enviamos un técnico.') as string,
    });
  });

  it('a una autora de personal le llega el enlace de oficina: /pqr?abrir=<id>', async () => {
    const autora = destinatario(1, 'personal', AUTOR.toString());
    const { servicio, directorio, enlaces } = montar();
    directorio.destinatarioDe.mockResolvedValue(autora);

    await servicio.notificarRespuesta(pqrDoc(), COPROPIEDAD, escritor, 'Hola');

    expect(enlaces.construir).toHaveBeenCalledWith(
      AUTOR.toString(),
      COPROPIEDAD.toString(),
      `/pqr?abrir=${PQR.toString()}`,
    );
  });

  it('crea la entrada en la app para la autora', async () => {
    const autora = destinatario(1, 'residente', AUTOR.toString());
    const { servicio, directorio, notificaciones } = montar();
    directorio.destinatarioDe.mockResolvedValue(autora);

    await servicio.notificarRespuesta(pqrDoc(), COPROPIEDAD, escritor, 'Hola');

    expect(notificaciones.crear).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      accountId: AUTOR.toString(),
      tipo: 'pqr',
      titulo: 'Nueva respuesta en tu PQR PQR-001',
    });
  });

  it('si quien escribe es la propia autora no se avisa a sí misma ni se consulta el directorio', async () => {
    const { servicio, directorio, correo, notificaciones } = montar();

    await servicio.notificarRespuesta(
      pqrDoc(),
      COPROPIEDAD,
      { accountId: AUTOR.toString(), nombre: 'Juan' },
      'Gracias',
    );

    expect(directorio.destinatarioDe).not.toHaveBeenCalled();
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
  });

  it('una PQR sin cuenta autora (registrada por personal) no avisa a nadie', async () => {
    const { servicio, directorio, correo } = montar();

    await servicio.notificarRespuesta(
      pqrDoc({ autorId: null }),
      COPROPIEDAD,
      escritor,
      'Hola',
    );

    expect(directorio.destinatarioDe).not.toHaveBeenCalled();
    expect(correo.enviar).not.toHaveBeenCalled();
  });

  it('si la autora ya no es alcanzable (cuenta inactiva, sin acceso) no recibe nada', async () => {
    const { servicio, directorio, enlaces, correo, notificaciones } = montar();
    directorio.destinatarioDe.mockResolvedValue(null);

    await servicio.notificarRespuesta(pqrDoc(), COPROPIEDAD, escritor, 'Hola');

    expect(enlaces.construir).not.toHaveBeenCalled();
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
  });

  it('nunca lanza, aunque falle el directorio o el envío', async () => {
    const { servicio, directorio, correo } = montar();
    directorio.destinatarioDe.mockRejectedValueOnce(new Error('mongo'));

    await expect(
      servicio.notificarRespuesta(pqrDoc(), COPROPIEDAD, escritor, 'Hola'),
    ).resolves.toBeUndefined();

    directorio.destinatarioDe.mockResolvedValue(
      destinatario(1, 'residente', AUTOR.toString()),
    );
    correo.enviar.mockRejectedValue(new Error('SendGrid caído'));
    await expect(
      servicio.notificarRespuesta(pqrDoc(), COPROPIEDAD, escritor, 'Hola'),
    ).resolves.toBeUndefined();
  });
});

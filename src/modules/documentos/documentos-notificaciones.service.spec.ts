import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import type { Destinatario } from '../../common/directorio/directorio.service';
import type { ActorDocumentos } from './documentos-acceso';
import {
  DocumentosNotificacionesService,
  ENVIOS_SIMULTANEOS,
} from './documentos-notificaciones.service';

const COPROPIEDAD = new Types.ObjectId();
const CARPETA_ID = new Types.ObjectId();
const ROL_LECTOR = new Types.ObjectId();
const ROL_AJENO = new Types.ObjectId();
const SUBE = new Types.ObjectId();

const destino = (
  nombre: string,
  perfil: 'personal' | 'residente' = 'personal',
  id = new Types.ObjectId().toString(),
): Destinatario => ({
  accountId: id,
  email: `${nombre}@x.co`,
  nombre,
  perfil,
});

const archivo = () => ({
  _id: new Types.ObjectId(),
  carpetaId: CARPETA_ID,
  nombre: 'Reglamento.pdf',
  autorNombre: 'Ana',
  subidoPorId: SUBE,
});

const carpeta = (acls: unknown[]) => ({
  _id: CARPETA_ID,
  carpetaPadreId: null,
  slug: 'reglamentos',
  acls,
});

const mapaCon = (acls: unknown[]) =>
  new Map([[CARPETA_ID.toString(), carpeta(acls)]]);

const regla = (rolId: Types.ObjectId) => ({
  tipo: 'rol',
  rolId,
  puedeLeer: true,
  puedeEscribir: false,
});

const residentes = (rol: string) => ({
  tipo: 'residentes',
  rol,
  puedeLeer: true,
  puedeEscribir: false,
});

function montar(opts: {
  personal?: Destinatario[];
  actores?: Record<string, ActorDocumentos>;
  residentes?: Destinatario[];
  tipos?: Record<string, Array<'propietario' | 'arrendatario'>>;
}) {
  const copropiedades = {
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ nombre: 'Torres del Parque' }),
      }),
    }),
  };
  const directorio = {
    personalQuePuedeLeer: jest.fn().mockResolvedValue(opts.personal ?? []),
    residentes: jest.fn().mockResolvedValue(opts.residentes ?? []),
  };
  const actores = {
    deCuentas: jest
      .fn()
      .mockResolvedValue(new Map(Object.entries(opts.actores ?? {}))),
  };
  const portalAcceso = {
    unidadesDe: jest.fn((id: string) =>
      Promise.resolve(
        (opts.tipos?.[id] ?? []).map((rol, i) => ({
          inmuebleId: `i${i}`,
          codigo: `A-${i}`,
          rol,
        })),
      ),
    ),
  };
  const correo = { enviar: jest.fn().mockResolvedValue(true) };
  const enlaces = { construir: jest.fn().mockResolvedValue('https://enlace') };
  const notificaciones = { crear: jest.fn().mockResolvedValue(undefined) };
  const servicio = new DocumentosNotificacionesService(
    copropiedades as never,
    directorio as never,
    actores as never,
    portalAcceso as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
  );
  return {
    servicio,
    directorio,
    actores,
    correo,
    enlaces,
    notificaciones,
    portalAcceso,
  };
}

const notificar = (
  servicio: DocumentosNotificacionesService,
  acls: unknown[],
  doc = archivo(),
) =>
  servicio.notificarNuevo(
    doc as never,
    mapaCon(acls) as never,
    'Reglamentos',
    COPROPIEDAD,
  );

const actor = (roles: Types.ObjectId[], gestiona = false): ActorDocumentos => ({
  roleIds: new Set(roles.map((r) => r.toString())),
  gestiona,
});

describe('DocumentosNotificacionesService — personal', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('avisa a quien tiene un rol con lectura y a quien gestiona, no a quien no alcanza la carpeta', async () => {
    const lector = destino('lector');
    const gestor = destino('gestor');
    const ajeno = destino('ajeno');
    const { servicio, correo, notificaciones } = montar({
      personal: [lector, gestor, ajeno],
      actores: {
        [lector.accountId]: actor([ROL_LECTOR]),
        [gestor.accountId]: actor([], true),
        [ajeno.accountId]: actor([ROL_AJENO]),
      },
    });

    await notificar(servicio, [regla(ROL_LECTOR)]);

    const avisados = (
      correo.enviar.mock.calls as Array<[{ para: string }]>
    ).map((c) => c[0].para);
    expect(avisados.sort()).toEqual(['gestor@x.co', 'lector@x.co']);
    expect(notificaciones.crear).toHaveBeenCalledWith(
      expect.objectContaining({
        copropiedadId: COPROPIEDAD,
        accountId: lector.accountId,
        tipo: 'documento',
        titulo: expect.stringContaining('Reglamento.pdf') as unknown,
      }),
    );
    expect(notificaciones.crear).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ajeno.accountId }),
    );
  });

  it('no avisa a quien subió el archivo', async () => {
    const autor = destino('autor', 'personal', SUBE.toString());
    const { servicio, correo, actores } = montar({
      personal: [autor],
      actores: { [SUBE.toString()]: actor([], true) },
    });

    await notificar(servicio, [regla(ROL_LECTOR)]);

    expect(correo.enviar).not.toHaveBeenCalled();
    expect(actores.deCuentas).toHaveBeenCalledWith([], COPROPIEDAD);
  });

  it('el audiencia de personal sale del directorio con la materia Documento', async () => {
    const { servicio, directorio } = montar({});
    await notificar(servicio, [regla(ROL_LECTOR)]);
    expect(directorio.personalQuePuedeLeer).toHaveBeenCalledWith(
      COPROPIEDAD,
      'Documento',
    );
  });

  it('una carpeta sin reglas solo avisa a quienes gestionan (privada por defecto)', async () => {
    const lector = destino('lector');
    const gestor = destino('gestor');
    const { servicio, correo } = montar({
      personal: [lector, gestor],
      actores: {
        [lector.accountId]: actor([ROL_LECTOR]),
        [gestor.accountId]: actor([], true),
      },
    });

    await notificar(servicio, []);

    expect(correo.enviar).toHaveBeenCalledTimes(1);
    expect(correo.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ para: 'gestor@x.co' }),
    );
  });

  it('el enlace del personal apunta a /documentos con la carpeta y el documento a abrir', async () => {
    const lector = destino('lector');
    const doc = archivo();
    const { servicio, enlaces } = montar({
      personal: [lector],
      actores: { [lector.accountId]: actor([ROL_LECTOR]) },
    });

    await notificar(servicio, [regla(ROL_LECTOR)], doc);

    expect(enlaces.construir).toHaveBeenCalledWith(
      lector.accountId,
      COPROPIEDAD.toString(),
      `/documentos?carpeta=reglamentos&abrir=${doc._id.toString()}`,
    );
  });

  it('un correo que falla no impide la entrada en la bandeja ni avisar a los demás', async () => {
    const a = destino('a');
    const b = destino('b');
    const { servicio, correo, notificaciones } = montar({
      personal: [a, b],
      actores: {
        [a.accountId]: actor([ROL_LECTOR]),
        [b.accountId]: actor([ROL_LECTOR]),
      },
    });
    correo.enviar.mockResolvedValueOnce(false);

    await notificar(servicio, [regla(ROL_LECTOR)]);

    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
  });

  it('nunca lanza: un fallo del directorio se registra y se traga', async () => {
    const { servicio, directorio } = montar({});
    directorio.personalQuePuedeLeer.mockRejectedValue(new Error('mongo'));
    await expect(
      notificar(servicio, [regla(ROL_LECTOR)]),
    ).resolves.toBeUndefined();
  });

  it('nunca lanza si falla el envío a un destinatario', async () => {
    const a = destino('a');
    const { servicio, enlaces } = montar({
      personal: [a],
      actores: { [a.accountId]: actor([ROL_LECTOR]) },
    });
    enlaces.construir.mockRejectedValue(new Error('firebase'));
    await expect(
      notificar(servicio, [regla(ROL_LECTOR)]),
    ).resolves.toBeUndefined();
  });

  it('envía en tandas de a lo sumo ENVIOS_SIMULTANEOS a la vez', async () => {
    const gestores = Array.from({ length: 25 }, (_, i) => destino(`g${i}`));
    const { servicio, correo } = montar({
      personal: gestores,
      actores: Object.fromEntries(
        gestores.map((g) => [g.accountId, actor([], true)]),
      ),
    });
    let activos = 0;
    let maximo = 0;
    correo.enviar.mockImplementation(async () => {
      activos += 1;
      maximo = Math.max(maximo, activos);
      await new Promise((r) => setImmediate(r));
      activos -= 1;
      return true;
    });

    await notificar(servicio, []);

    expect(correo.enviar).toHaveBeenCalledTimes(25);
    expect(maximo).toBeLessThanOrEqual(ENVIOS_SIMULTANEOS);
  });
});

describe('DocumentosNotificacionesService — residentes', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sin ninguna regla de residentes ni siquiera consulta a los residentes', async () => {
    const { servicio, directorio } = montar({});
    await notificar(servicio, [regla(ROL_LECTOR)]);
    expect(directorio.residentes).not.toHaveBeenCalled();
  });

  it('avisa a propietarios cuando la regla es de propietarios, no a arrendatarios', async () => {
    const dueno = destino('dueno', 'residente');
    const inquilino = destino('inquilino', 'residente');
    const { servicio, correo } = montar({
      residentes: [dueno, inquilino],
      tipos: {
        [dueno.accountId]: ['propietario'],
        [inquilino.accountId]: ['arrendatario'],
      },
    });

    await notificar(servicio, [residentes('propietario')]);

    expect(correo.enviar).toHaveBeenCalledTimes(1);
    expect(correo.enviar).toHaveBeenCalledWith(
      expect.objectContaining({ para: 'dueno@x.co' }),
    );
  });

  it('"todos" avisa a propietarios y arrendatarios', async () => {
    const dueno = destino('dueno', 'residente');
    const inquilino = destino('inquilino', 'residente');
    const { servicio, correo } = montar({
      residentes: [dueno, inquilino],
      tipos: {
        [dueno.accountId]: ['propietario'],
        [inquilino.accountId]: ['arrendatario'],
      },
    });

    await notificar(servicio, [residentes('todos')]);

    expect(correo.enviar).toHaveBeenCalledTimes(2);
  });

  it('el enlace del residente apunta a /portal/documentos', async () => {
    const dueno = destino('dueno', 'residente');
    const doc = archivo();
    const { servicio, enlaces } = montar({
      residentes: [dueno],
      tipos: { [dueno.accountId]: ['propietario'] },
    });

    await notificar(servicio, [residentes('todos')], doc);

    expect(enlaces.construir).toHaveBeenCalledWith(
      dueno.accountId,
      COPROPIEDAD.toString(),
      `/portal/documentos?carpeta=reglamentos&abrir=${doc._id.toString()}`,
    );
  });

  it('quien es personal y residente recibe un solo aviso, como personal', async () => {
    const ambos = destino('ambos');
    const { servicio, correo } = montar({
      personal: [ambos],
      actores: { [ambos.accountId]: actor([], true) },
      residentes: [{ ...ambos, perfil: 'residente' }],
      tipos: { [ambos.accountId]: ['propietario'] },
    });

    await notificar(servicio, [residentes('todos')]);

    expect(correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('no avisa al residente que subió el archivo', async () => {
    const autor = destino('autor', 'residente', SUBE.toString());
    const { servicio, correo } = montar({
      residentes: [autor],
      tipos: { [SUBE.toString()]: ['propietario'] },
    });
    await notificar(servicio, [residentes('todos')]);
    expect(correo.enviar).not.toHaveBeenCalled();
  });
});

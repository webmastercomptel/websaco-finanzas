import { Types } from 'mongoose';
import type { ResidenteDeInmueble } from '../../common/directorio/directorio.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { ETIQUETA_UNIDAD } from './detector-unidades';
import { FacturacionBloqueEntregaService } from './facturacion-bloque-entrega.service';
import { FacturacionBloqueIngestaService } from './facturacion-bloque-ingesta.service';
import { FacturacionBloquePortalService } from './facturacion-bloque-portal.service';

/**
 * Wires the real ingest, delivery and portal services over ONE in-memory
 * "database" and ONE set of mail/notification doubles, to prove the central
 * promise of this module: finishing the ingest sends nothing, and only the
 * explicit send does.
 */

interface Consulta {
  exec: jest.Mock;
  select: jest.Mock;
  lean: jest.Mock;
}
const consulta = (valor: unknown): Consulta => {
  const q = {} as Consulta;
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.lean = jest.fn().mockReturnValue(q);
  return q;
};

const COPROPIEDAD = new Types.ObjectId();
const BLOQUE = new Types.ObjectId();
const ADMIN: IRequestUser = {
  uid: 'u',
  email: 'a@b.co',
  accountId: new Types.ObjectId().toString(),
  nombre: 'Ana Administradora',
};

function montar() {
  const u301 = new Types.ObjectId();
  const u302 = new Types.ObjectId();
  const dueno = new Types.ObjectId().toString();
  const inquilino = new Types.ObjectId().toString();

  // The block, as the "database" holds it.
  const bloque: Record<string, unknown> = {
    _id: BLOQUE,
    copropiedadId: COPROPIEDAD,
    tipo: 'factura',
    periodo: '2026-07',
    nombre: 'bloque.pdf',
    rutaOriginal: 'facturacion-bloque/x/y/original.pdf',
    estado: 'pendiente',
    destinatariosTotal: 0,
    correoConfigurado: null,
    enviadoEn: null,
    enviadoPorNombre: '',
    createdAt: new Date('2026-07-01T09:00:00.000Z'),
    updatedAt: new Date('2026-07-01T09:00:00.000Z'),
  };
  const documentosGuardados: Array<Record<string, unknown>> = [];

  const bloques = {
    findOneAndUpdate: jest.fn().mockImplementation((filtro: unknown) => {
      const f = filtro as { $or?: unknown[]; tipo?: unknown };
      // Ingest claims `pendiente`; delivery claims `generado`.
      const esIngesta = JSON.stringify(f.$or).includes('"pendiente"');
      if (esIngesta && bloque.estado === 'pendiente') {
        bloque.estado = 'procesando';
        return consulta(bloque);
      }
      if (!esIngesta && bloque.estado === 'generado') {
        bloque.estado = 'pendiente_envio';
        bloque.enviadoEn = new Date();
        return consulta(bloque);
      }
      return consulta(null);
    }),
    findOne: jest.fn().mockImplementation(() => consulta(bloque)),
    updateOne: jest.fn().mockImplementation((_f: unknown, cambio: unknown) => {
      const set = (cambio as { $set: Record<string, unknown> }).$set;
      if (typeof set.estado === 'string') Object.assign(bloque, set);
      return consulta({ matchedCount: 1 });
    }),
    exists: jest
      .fn()
      .mockImplementation(() =>
        consulta(
          ['pendiente_envio', 'enviado'].includes(bloque.estado as string)
            ? { _id: BLOQUE }
            : null,
        ),
      ),
    find: jest
      .fn()
      .mockImplementation(() =>
        consulta(
          ['pendiente_envio', 'enviado'].includes(bloque.estado as string)
            ? [bloque]
            : [],
        ),
      ),
  };
  const documentos = {
    create: jest.fn().mockImplementation((d: Record<string, unknown>) => {
      documentosGuardados.push({
        _id: new Types.ObjectId(),
        notificadosIds: [],
        correosEnviadosIds: [],
        ...d,
      });
      return Promise.resolve();
    }),
    deleteMany: jest.fn().mockReturnValue(consulta({})),
    find: jest.fn().mockImplementation(() => consulta(documentosGuardados)),
    updateOne: jest.fn().mockImplementation((f: unknown, cambio: unknown) => {
      const { _id } = f as { _id: Types.ObjectId };
      const agregar = (cambio as { $addToSet: Record<string, Types.ObjectId> })
        .$addToSet;
      const doc = documentosGuardados.find((d) =>
        _id.equals(d._id as Types.ObjectId),
      );
      for (const [campo, valor] of Object.entries(agregar)) {
        (doc?.[campo] as Types.ObjectId[]).push(valor);
      }
      return consulta({ matchedCount: 1 });
    }),
  };
  const inmuebles = {
    find: jest.fn().mockReturnValue(
      consulta([
        { _id: u301, codigo: '301' },
        { _id: u302, codigo: '302' },
      ]),
    ),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const almacen = {
    tamanoReal: jest.fn().mockResolvedValue(1000),
    descargar: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    subir: jest.fn().mockResolvedValue(undefined),
    eliminar: jest.fn().mockResolvedValue(true),
    eliminarPrefijo: jest
      .fn()
      .mockResolvedValue({ eliminados: 0, fallidos: 0 }),
    firmarLectura: jest.fn().mockResolvedValue('https://storage.test/firmada'),
  };
  const lector = {
    textoPorPagina: jest
      .fn()
      .mockResolvedValue([
        `${ETIQUETA_UNIDAD}: 301 Total`,
        `${ETIQUETA_UNIDAD}: 302 Total`,
      ]),
    dividir: jest
      .fn()
      .mockImplementation(
        async (
          _o: Uint8Array,
          grupos: Array<{ clave: string }>,
          alProducir: (c: string, p: Uint8Array) => Promise<void>,
        ) => {
          for (const g of grupos) await alProducir(g.clave, new Uint8Array(2));
        },
      ),
  };
  const lock = {
    runExclusive: jest
      .fn()
      .mockImplementation(
        async (_k: string, _t: number, tarea: () => Promise<void>) => {
          await tarea();
          return true;
        },
      ),
  };

  const residentes = (id: Types.ObjectId): ResidenteDeInmueble[] =>
    id.equals(u301)
      ? [
          {
            accountId: dueno,
            email: 'dueno@example.com',
            nombre: 'Dueño',
            perfil: 'residente',
            rol: 'propietario',
          },
          {
            accountId: inquilino,
            email: 'inquilino@example.com',
            nombre: 'Inquilino',
            perfil: 'residente',
            rol: 'arrendatario',
          },
        ]
      : [];
  const directorio = {
    residentesDeInmuebles: jest
      .fn()
      .mockImplementation((_c: Types.ObjectId, ids: Types.ObjectId[]) =>
        Promise.resolve(
          new Map(ids.map((id) => [id.toString(), residentes(id)])),
        ),
      ),
  };
  const correo = {
    estaConfigurado: jest.fn().mockReturnValue(true),
    enviar: jest.fn().mockResolvedValue(true),
  };
  const enlaces = {
    construir: jest.fn().mockResolvedValue('https://app.test/x'),
  };
  const notificaciones = { crear: jest.fn().mockResolvedValue(true) };
  const copropiedades = {
    findById: jest.fn().mockReturnValue(consulta({ nombre: 'Torres' })),
  };
  const portalAcceso = {
    unidadesDe: jest
      .fn()
      .mockResolvedValue([
        { inmuebleId: u301.toString(), codigo: '301', rol: 'propietario' },
      ]),
    rolEn: jest.fn().mockResolvedValue('propietario'),
  };

  const ingesta = new FacturacionBloqueIngestaService(
    bloques as never,
    documentos as never,
    inmuebles as never,
    tenant as never,
    almacen as never,
    lector,
    lock as never,
  );
  const entrega = new FacturacionBloqueEntregaService(
    bloques as never,
    documentos as never,
    copropiedades as never,
    tenant as never,
    directorio as never,
    correo as never,
    enlaces as never,
    notificaciones as never,
  );
  const portal = new FacturacionBloquePortalService(
    documentos as never,
    bloques as never,
    tenant as never,
    portalAcceso as never,
    almacen as never,
  );
  const residente: IRequestUser = {
    uid: 'r',
    email: 'dueno@example.com',
    accountId: dueno,
    esResidente: true,
  };
  return {
    bloque,
    ingesta,
    entrega,
    portal,
    correo,
    enlaces,
    notificaciones,
    directorio,
    documentosGuardados,
    residente,
  };
}

describe('facturación por bloque — nada sale sin la acción explícita de enviar', () => {
  it('procesar el bloque deja los documentos generados y NO envía correo, enlace ni notificación a nadie', async () => {
    const { ingesta, bloque, correo, enlaces, notificaciones, directorio } =
      montar();

    await ingesta.procesar(BLOQUE.toString());

    expect(bloque.estado).toBe('generado');
    expect(correo.enviar).not.toHaveBeenCalled();
    expect(enlaces.construir).not.toHaveBeenCalled();
    expect(notificaciones.crear).not.toHaveBeenCalled();
    // Ni siquiera resuelve destinatarios: eso es del envío.
    expect(directorio.residentesDeInmuebles).not.toHaveBeenCalled();
  });

  it('mientras el bloque está generado, el residente NO ve sus documentos', async () => {
    const { ingesta, portal, residente } = montar();
    await ingesta.procesar(BLOQUE.toString());

    await expect(portal.listar({}, residente)).resolves.toEqual([]);
  });

  it('solo la acción de enviar notifica; después el residente ve su documento y el propietario Y el arrendatario fueron avisados', async () => {
    const {
      ingesta,
      entrega,
      portal,
      residente,
      correo,
      notificaciones,
      bloque,
    } = montar();
    await ingesta.procesar(BLOQUE.toString());
    expect(correo.enviar).not.toHaveBeenCalled();

    const respuesta = await entrega.enviar(BLOQUE.toString(), ADMIN);

    expect(respuesta.estado).toBe('enviado');
    expect(bloque.estado).toBe('enviado');
    expect(
      correo.enviar.mock.calls
        .map(([m]) => (m as { para: string }).para)
        .sort(),
    ).toEqual(['dueno@example.com', 'inquilino@example.com']);
    expect(notificaciones.crear).toHaveBeenCalledTimes(2);
    const lista = await portal.listar({}, residente);
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      codigoInmueble: '301',
      rol: 'propietario',
    });
  });

  it('enviar dos veces: la segunda es 409 y no manda nada más', async () => {
    const { ingesta, entrega, correo, bloque } = montar();
    await ingesta.procesar(BLOQUE.toString());
    await entrega.enviar(BLOQUE.toString(), ADMIN);
    const enviados = correo.enviar.mock.calls.length;
    // The claim finds nothing claimable now: tell it the state is `enviado`.
    expect(bloque.estado).toBe('enviado');

    await expect(entrega.enviar(BLOQUE.toString(), ADMIN)).rejects.toThrow(
      'ya fue enviado',
    );
    expect(correo.enviar).toHaveBeenCalledTimes(enviados);
  });

  it('no se puede enviar un bloque que todavía no se procesó', async () => {
    const { entrega, correo, bloque } = montar();
    expect(bloque.estado).toBe('pendiente');

    await expect(entrega.enviar(BLOQUE.toString(), ADMIN)).rejects.toThrow(
      'todavía no está procesado',
    );
    expect(correo.enviar).not.toHaveBeenCalled();
  });
});

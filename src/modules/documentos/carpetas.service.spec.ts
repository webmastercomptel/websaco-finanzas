import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { ActorDocumentos } from './documentos-acceso';
import { CarpetasService } from './carpetas.service';
import type { AclCarpetaDto } from './dto/guardar-carpeta.dto';

const COPROPIEDAD = new Types.ObjectId();
const user: IRequestUser = { uid: 'u', email: 'a@b.co', accountId: 'x' };

const consulta = (valor: unknown) => {
  const q: Record<string, jest.Mock> = {};
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.lean = jest.fn().mockReturnValue(q);
  return q;
};

interface AclPlano {
  tipo: 'rol' | 'residentes';
  rolId?: Types.ObjectId;
  rol?: 'propietario' | 'arrendatario' | 'todos';
  puedeLeer: boolean;
  puedeEscribir: boolean;
}

const conteo = (n: number) => ({ exec: jest.fn().mockResolvedValue(n) });

const carpeta = (
  extra: Partial<{
    _id: Types.ObjectId;
    slug: string;
    nombre: string;
    carpetaPadreId: Types.ObjectId | null;
    acls: AclPlano[];
  }> = {},
) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COPROPIEDAD,
  carpetaPadreId: null,
  slug: 'actas',
  nombre: 'Actas',
  descripcion: '',
  icono: 'folder',
  color: '#64748b',
  acls: [] as AclPlano[],
  updatedAt: new Date('2026-02-01T00:00:00Z'),
  ...extra,
});

const rolDe = (
  id: Types.ObjectId,
  leer = true,
  escribir = false,
): AclPlano => ({
  tipo: 'rol',
  rolId: id,
  puedeLeer: leer,
  puedeEscribir: escribir,
});

const actor = (roles: Types.ObjectId[], gestiona = false): ActorDocumentos => ({
  roleIds: new Set(roles.map((r) => r.toString())),
  gestiona,
});

function montar(
  existentes: ReturnType<typeof carpeta>[],
  a: ActorDocumentos,
  extra: { rolesPropios?: Types.ObjectId[] } = {},
) {
  const guardadas: Array<Record<string, unknown>> = [];
  const carpetasModelo = Object.assign(
    jest.fn().mockImplementation((datos: Record<string, unknown>) => {
      const creada = {
        _id: new Types.ObjectId(),
        updatedAt: new Date(),
        ...datos,
      };
      return {
        save: jest.fn().mockImplementation(() => {
          guardadas.push(creada);
          return Promise.resolve(creada);
        }),
      };
    }),
    {
      find: jest.fn().mockReturnValue(consulta(existentes)),
      findOneAndUpdate: jest.fn(),
      deleteOne: jest.fn(),
      countDocuments: jest.fn().mockReturnValue(conteo(0)),
    },
  );
  const archivos = {
    aggregate: jest.fn().mockReturnValue(consulta([])),
    countDocuments: jest.fn().mockReturnValue(conteo(0)),
  };
  const roles = {
    find: jest
      .fn()
      .mockReturnValue(
        consulta((extra.rolesPropios ?? []).map((_id) => ({ _id }))),
      ),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const actores = { deSolicitud: jest.fn().mockResolvedValue(a) };
  const servicio = new CarpetasService(
    carpetasModelo as never,
    archivos as never,
    roles as never,
    tenant as never,
    actores as never,
  );
  return { servicio, carpetasModelo, archivos, roles, guardadas };
}

describe('CarpetasService.listar — visibilidad del personal', () => {
  const ROL_A = new Types.ObjectId();
  const ROL_B = new Types.ObjectId();

  it('muestra solo las carpetas cuya regla de rol permite leer al usuario', async () => {
    const visible = carpeta({ slug: 'actas', acls: [rolDe(ROL_A)] });
    const ajena = carpeta({
      slug: 'legal',
      nombre: 'Legal',
      acls: [rolDe(ROL_B)],
    });
    const privada = carpeta({ slug: 'privada', nombre: 'Privada', acls: [] });
    const { servicio } = montar([visible, ajena, privada], actor([ROL_A]));

    const res = await servicio.listar({}, user);

    expect(res.map((c) => c.slug)).toEqual(['actas']);
    expect(res[0].permisos).toEqual({
      puedeLeer: true,
      puedeEscribir: false,
      puedeAdministrar: false,
    });
  });

  it('quien gestiona ve todas, incluidas las privadas, con administración', async () => {
    const privada = carpeta({ slug: 'privada', acls: [] });
    const ajena = carpeta({
      slug: 'legal',
      nombre: 'Legal',
      acls: [rolDe(ROL_B)],
    });
    const { servicio } = montar([privada, ajena], actor([], true));

    const res = await servicio.listar({}, user);

    expect(res).toHaveLength(2);
    expect(res.every((c) => c.permisos.puedeAdministrar)).toBe(true);
  });

  it('lista solo los hijos del padre pedido, o la raíz si no se pide', async () => {
    const raiz = carpeta({
      slug: 'raiz',
      nombre: 'Raíz',
      acls: [rolDe(ROL_A)],
    });
    const hija = carpeta({
      slug: 'hija',
      nombre: 'Hija',
      carpetaPadreId: raiz._id,
      acls: [rolDe(ROL_A)],
    });
    const { servicio } = montar([raiz, hija], actor([ROL_A]));

    expect((await servicio.listar({}, user)).map((c) => c.slug)).toEqual([
      'raiz',
    ]);
    expect(
      (await servicio.listar({ parent: raiz._id.toString() }, user)).map(
        (c) => c.slug,
      ),
    ).toEqual(['hija']);
  });

  it('una carpeta sin reglas propias muestra de quién hereda', async () => {
    const padre = carpeta({
      slug: 'padre',
      nombre: 'Padre',
      acls: [rolDe(ROL_A)],
    });
    const hija = carpeta({
      slug: 'hija',
      nombre: 'Hija',
      carpetaPadreId: padre._id,
    });
    const { servicio } = montar([padre, hija], actor([ROL_A]));

    const [res] = await servicio.listar({ parent: padre._id.toString() }, user);

    expect(res.heredaDe).toBe('Padre');
    expect(res.permisosHeredados).toEqual([
      {
        tipo: 'rol',
        rolId: ROL_A.toString(),
        puedeLeer: true,
        puedeEscribir: false,
      },
    ]);
  });

  it('carga las carpetas solo de la copropiedad activa', async () => {
    const { servicio, carpetasModelo } = montar([], actor([]));
    await servicio.listar({}, user);
    expect(carpetasModelo.find).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
    });
  });
});

describe('CarpetasService.porSlug y ruta', () => {
  const ROL = new Types.ObjectId();

  it('porSlug: carpeta que el personal no puede leer es 403', async () => {
    const c = carpeta({ acls: [rolDe(new Types.ObjectId())] });
    const { servicio } = montar([c], actor([ROL]));
    await expect(servicio.porSlug('actas', user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('porSlug: slug inexistente es 404', async () => {
    const { servicio } = montar([], actor([], true));
    await expect(servicio.porSlug('nada', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('ruta: id mal formado es 404 sin consultar nada', async () => {
    const { servicio, carpetasModelo } = montar([], actor([], true));
    await expect(servicio.ruta('no-es-un-id', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(carpetasModelo.find).not.toHaveBeenCalled();
  });

  it('ruta: arma el camino raíz -> carpeta', async () => {
    const raiz = carpeta({ slug: 'raiz', nombre: 'Raíz', acls: [rolDe(ROL)] });
    const hija = carpeta({
      slug: 'hija',
      nombre: 'Hija',
      carpetaPadreId: raiz._id,
    });
    const { servicio } = montar([raiz, hija], actor([ROL]));
    const res = await servicio.ruta(hija._id.toString(), user);
    expect(res.map((r) => r.slug)).toEqual(['raiz', 'hija']);
  });

  it('ruta: una carpeta de otra copropiedad no está en el mapa y es 404', async () => {
    const { servicio } = montar([], actor([], true));
    await expect(
      servicio.ruta(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('CarpetasService.crear — reglas (ACL)', () => {
  const ROL_PROPIO = new Types.ObjectId();
  const ROL_AJENO = new Types.ObjectId();

  const aclRol = (rolId: Types.ObjectId): AclCarpetaDto => ({
    tipo: 'rol',
    rolId: rolId.toString(),
    puedeLeer: true,
    puedeEscribir: true,
  });

  it('solo quien gestiona puede crear carpetas', async () => {
    const { servicio, carpetasModelo } = montar([], actor([ROL_PROPIO]));
    await expect(
      servicio.crear({ nombre: 'Nueva' }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(carpetasModelo).not.toHaveBeenCalled();
  });

  it('rechaza con 400 un rolId que no pertenece a la copropiedad activa', async () => {
    const { servicio, roles, guardadas } = montar([], actor([], true), {
      rolesPropios: [ROL_PROPIO],
    });
    await expect(
      servicio.crear(
        { nombre: 'Nueva', acls: [aclRol(ROL_PROPIO), aclRol(ROL_AJENO)] },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The lookup is scoped to the coproperty, so a foreign role cannot be found.
    expect(roles.find).toHaveBeenCalledWith({
      _id: { $in: [ROL_PROPIO.toString(), ROL_AJENO.toString()] },
      copropiedadId: COPROPIEDAD,
    });
    expect(guardadas).toHaveLength(0);
  });

  it('acepta roles de la copropiedad y guarda el rolId como ObjectId', async () => {
    const { servicio, guardadas } = montar([], actor([], true), {
      rolesPropios: [ROL_PROPIO],
    });
    await servicio.crear({ nombre: 'Nueva', acls: [aclRol(ROL_PROPIO)] }, user);
    const acls = guardadas[0].acls as Array<{ rolId: Types.ObjectId }>;
    expect(acls[0].rolId).toBeInstanceOf(Types.ObjectId);
    expect(acls[0].rolId.equals(ROL_PROPIO)).toBe(true);
  });

  it('no consulta roles si las reglas son solo de residentes', async () => {
    const { servicio, roles, guardadas } = montar([], actor([], true));
    await servicio.crear(
      {
        nombre: 'Para vecinos',
        acls: [
          {
            tipo: 'residentes',
            rol: 'todos',
            puedeLeer: true,
            puedeEscribir: false,
          },
        ],
      },
      user,
    );
    expect(roles.find).not.toHaveBeenCalled();
    expect(guardadas[0].acls).toEqual([
      {
        tipo: 'residentes',
        rol: 'todos',
        puedeLeer: true,
        puedeEscribir: false,
      },
    ]);
  });

  it.each([
    [
      'residentes que escriben',
      {
        tipo: 'residentes',
        rol: 'propietario',
        puedeLeer: true,
        puedeEscribir: true,
      },
    ],
    [
      'residentes sin rol',
      { tipo: 'residentes', puedeLeer: true, puedeEscribir: false },
    ],
    [
      'residentes con rolId',
      {
        tipo: 'residentes',
        rol: 'todos',
        rolId: new Types.ObjectId().toString(),
        puedeLeer: true,
        puedeEscribir: false,
      },
    ],
    ['rol sin rolId', { tipo: 'rol', puedeLeer: true, puedeEscribir: false }],
    [
      'rol con campo rol',
      {
        tipo: 'rol',
        rolId: new Types.ObjectId().toString(),
        rol: 'todos',
        puedeLeer: true,
        puedeEscribir: false,
      },
    ],
  ] as Array<[string, AclCarpetaDto]>)(
    'rechaza con 400 una regla mal formada: %s',
    async (_nombre, acl) => {
      const { servicio, guardadas } = montar([], actor([], true), {
        rolesPropios: [],
      });
      await expect(
        servicio.crear({ nombre: 'X', acls: [acl] }, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(guardadas).toHaveLength(0);
    },
  );

  it('genera un slug único por copropiedad con sufijo numérico', async () => {
    const { servicio, guardadas } = montar(
      [carpeta({ slug: 'actas' }), carpeta({ slug: 'actas-2' })],
      actor([], true),
    );
    await servicio.crear({ nombre: 'Actas' }, user);
    expect(guardadas[0].slug).toBe('actas-3');
  });

  it('normaliza acentos y símbolos en el slug', async () => {
    const { servicio, guardadas } = montar([], actor([], true));
    await servicio.crear({ nombre: 'Reglamento: Convivencia 2026' }, user);
    expect(guardadas[0].slug).toBe('reglamento-convivencia-2026');
  });

  it('guarda siempre la copropiedad del contexto, no una del payload', async () => {
    const { servicio, guardadas } = montar([], actor([], true));
    await servicio.crear({ nombre: 'Nueva' }, user);
    expect(guardadas[0].copropiedadId).toBe(COPROPIEDAD);
  });

  it('una carpeta padre que no es de esta copropiedad es 404', async () => {
    const { servicio, guardadas } = montar([], actor([], true));
    await expect(
      servicio.crear(
        { nombre: 'Hija', parentId: new Types.ObjectId().toString() },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(guardadas).toHaveLength(0);
  });

  it('una clave duplicada de Mongo (carrera de slugs) es 409', async () => {
    const { servicio, carpetasModelo } = montar([], actor([], true));
    carpetasModelo.mockImplementationOnce(() => ({
      save: jest.fn().mockRejectedValue({ code: 11000 }),
    }));
    await expect(servicio.crear({ nombre: 'X' }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('CarpetasService.actualizar', () => {
  it('solo quien gestiona edita carpetas', async () => {
    const c = carpeta();
    const { servicio, carpetasModelo } = montar(
      [c],
      actor([new Types.ObjectId()]),
    );
    await expect(
      servicio.actualizar(c._id.toString(), { nombre: 'Otro' }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(carpetasModelo.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('id mal formado es 404', async () => {
    const { servicio } = montar([], actor([], true));
    await expect(
      servicio.actualizar('xyz', { nombre: 'Otro' }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('una carpeta que no es de la copropiedad es 404 y no escribe', async () => {
    const { servicio, carpetasModelo } = montar([], actor([], true));
    await expect(
      servicio.actualizar(
        new Types.ObjectId().toString(),
        { nombre: 'Z' },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(carpetasModelo.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('actualiza con $set filtrando por id Y copropiedad, sin tocar el slug', async () => {
    const c = carpeta();
    const { servicio, carpetasModelo } = montar([c], actor([], true));
    carpetasModelo.findOneAndUpdate.mockReturnValue(
      consulta({ ...c, nombre: 'Nuevo nombre' }),
    );

    const res = await servicio.actualizar(
      c._id.toString(),
      { nombre: 'Nuevo nombre' },
      user,
    );

    expect(carpetasModelo.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: c._id.toString(), copropiedadId: COPROPIEDAD },
      { $set: { nombre: 'Nuevo nombre' } },
      { new: true },
    );
    expect(res.nombre).toBe('Nuevo nombre');
    expect(res.slug).toBe('actas');
  });

  it('valida los roles de las reglas nuevas contra la copropiedad', async () => {
    const c = carpeta();
    const { servicio, carpetasModelo } = montar([c], actor([], true), {
      rolesPropios: [],
    });
    await expect(
      servicio.actualizar(
        c._id.toString(),
        {
          acls: [
            {
              tipo: 'rol',
              rolId: new Types.ObjectId().toString(),
              puedeLeer: true,
              puedeEscribir: false,
            },
          ],
        },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(carpetasModelo.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('acls vacías reemplazan las reglas (vuelve a heredar)', async () => {
    const c = carpeta({ acls: [rolDe(new Types.ObjectId())] });
    const { servicio, carpetasModelo } = montar([c], actor([], true));
    carpetasModelo.findOneAndUpdate.mockReturnValue(
      consulta({ ...c, acls: [] }),
    );

    await servicio.actualizar(c._id.toString(), { acls: [] }, user);

    expect(carpetasModelo.findOneAndUpdate).toHaveBeenCalledWith(
      expect.anything(),
      { $set: { acls: [] } },
      expect.anything(),
    );
  });
});

describe('CarpetasService.eliminar', () => {
  it('solo quien gestiona elimina carpetas', async () => {
    const { servicio, carpetasModelo } = montar(
      [],
      actor([new Types.ObjectId()]),
    );
    await expect(
      servicio.eliminar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(carpetasModelo.deleteOne).not.toHaveBeenCalled();
  });

  it('id mal formado es 404', async () => {
    const { servicio } = montar([], actor([], true));
    await expect(servicio.eliminar('xyz', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('se niega con 409 si la carpeta tiene archivos', async () => {
    const { servicio, archivos, carpetasModelo } = montar([], actor([], true));
    archivos.countDocuments.mockReturnValue(conteo(2));
    await expect(
      servicio.eliminar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(carpetasModelo.deleteOne).not.toHaveBeenCalled();
  });

  it('se niega con 409 si tiene subcarpetas', async () => {
    const { servicio, carpetasModelo } = montar([], actor([], true));
    carpetasModelo.countDocuments.mockReturnValue(conteo(1));
    await expect(
      servicio.eliminar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('borra una carpeta vacía filtrando por id Y copropiedad', async () => {
    const id = new Types.ObjectId();
    const { servicio, carpetasModelo, archivos } = montar([], actor([], true));
    carpetasModelo.deleteOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    });

    await expect(servicio.eliminar(id.toString(), user)).resolves.toEqual({
      id: id.toString(),
    });
    expect(carpetasModelo.deleteOne).toHaveBeenCalledWith({
      _id: id,
      copropiedadId: COPROPIEDAD,
    });
    expect(archivos.countDocuments).toHaveBeenCalledWith({
      copropiedadId: COPROPIEDAD,
      carpetaId: id,
    });
  });

  it('si no se borró nada (otra copropiedad o ya no existe) es 404', async () => {
    const { servicio, carpetasModelo } = montar([], actor([], true));
    carpetasModelo.deleteOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    });
    await expect(
      servicio.eliminar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { RolPortal } from '../portal/portal-acceso.service';
import { CarpetasService } from './carpetas.service';
import { PREFIJO_DOCUMENTOS } from './documentos-almacen.service';
import { DocumentosPortalService } from './documentos-portal.service';

const COPROPIEDAD = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const user: IRequestUser = {
  uid: 'u',
  email: 'r@x.co',
  accountId: CUENTA.toString(),
  esResidente: true,
  copropiedadId: COPROPIEDAD.toString(),
};

const consulta = (valor: unknown) => {
  const q: Record<string, jest.Mock> = {};
  q.exec = jest.fn().mockResolvedValue(valor);
  q.sort = jest.fn().mockReturnValue(q);
  return q;
};

const ROL_STAFF = new Types.ObjectId();

const carpeta = (
  slug: string,
  acls: unknown[],
  extra: Record<string, unknown> = {},
) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COPROPIEDAD,
  carpetaPadreId: null,
  slug,
  nombre: slug.toUpperCase(),
  descripcion: '',
  icono: 'folder',
  color: '#000',
  acls,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...extra,
});

const paraResidentes = (r: 'propietario' | 'arrendatario' | 'todos') => ({
  tipo: 'residentes',
  rol: r,
  puedeLeer: true,
  puedeEscribir: false,
});

const PROPIETARIOS = carpeta('propietarios', [paraResidentes('propietario')]);
const ARRENDATARIOS = carpeta('arrendatarios', [
  paraResidentes('arrendatario'),
]);
const TODOS = carpeta('todos-los-vecinos', [paraResidentes('todos')]);
const SOLO_STAFF = carpeta('solo-staff', [
  { tipo: 'rol', rolId: ROL_STAFF, puedeLeer: true, puedeEscribir: true },
]);
const PRIVADA = carpeta('privada', []);

const archivoDoc = (
  carpetaId: Types.ObjectId,
  extra: Record<string, unknown> = {},
) => ({
  _id: new Types.ObjectId(),
  copropiedadId: COPROPIEDAD,
  carpetaId,
  codigo: 'DOC-001',
  nombre: 'Reglamento.pdf',
  tipo: 'pdf',
  categoria: '',
  rutaAlmacenamiento: `${PREFIJO_DOCUMENTOS}${COPROPIEDAD.toString()}/uuid-Reglamento.pdf`,
  estado: 'listo',
  tamanoBytes: 10,
  autorNombre: 'Ana',
  destacado: false,
  etiquetas: [],
  updatedAt: new Date('2026-03-01T00:00:00Z'),
  ...extra,
});

function montar(roles: RolPortal[]) {
  const archivos = {
    find: jest.fn().mockReturnValue(consulta([])),
    findOne: jest.fn().mockReturnValue(consulta(null)),
    aggregate: jest.fn().mockReturnValue(consulta([])),
  };
  const carpetasModelo = {
    find: jest
      .fn()
      .mockReturnValue(
        consulta([PROPIETARIOS, ARRENDATARIOS, TODOS, SOLO_STAFF, PRIVADA]),
      ),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const carpetas = new CarpetasService(
    carpetasModelo as never,
    archivos as never,
    {} as never,
    tenant as never,
    {} as never,
  );
  const portalAcceso = {
    unidadesDe: jest
      .fn()
      .mockResolvedValue(
        roles.map((rol, i) => ({ inmuebleId: `i${i}`, codigo: `A-${i}`, rol })),
      ),
  };
  const almacen = {
    firmarLectura: jest.fn().mockResolvedValue('https://storage/lectura'),
  };
  const servicio = new DocumentosPortalService(
    archivos as never,
    tenant as never,
    carpetas,
    portalAcceso as never,
    almacen as never,
  );
  return { servicio, archivos, portalAcceso, almacen };
}

describe('DocumentosPortalService.listarCarpetas', () => {
  it('un propietario ve las carpetas de propietarios y de todos, y nada más', async () => {
    const { servicio } = montar(['propietario']);
    const res = await servicio.listarCarpetas({}, user);
    expect(res.map((c) => c.slug).sort()).toEqual(
      ['propietarios', 'todos-los-vecinos'].sort(),
    );
  });

  it('un arrendatario ve las carpetas de arrendatarios y de todos, nunca las de propietarios', async () => {
    const { servicio } = montar(['arrendatario']);
    const res = await servicio.listarCarpetas({}, user);
    expect(res.map((c) => c.slug).sort()).toEqual(
      ['arrendatarios', 'todos-los-vecinos'].sort(),
    );
  });

  it('quien es propietario de una unidad y arrendatario de otra ve ambas audiencias', async () => {
    const { servicio } = montar(['propietario', 'arrendatario']);
    const res = await servicio.listarCarpetas({}, user);
    expect(res).toHaveLength(3);
  });

  it('las carpetas de roles del personal y las privadas nunca se listan', async () => {
    const { servicio } = montar(['propietario', 'arrendatario']);
    const slugs = (await servicio.listarCarpetas({}, user)).map((c) => c.slug);
    expect(slugs).not.toContain('solo-staff');
    expect(slugs).not.toContain('privada');
  });

  it('no filtra reglas, ids de rol ni permisos hacia el residente', async () => {
    const { servicio } = montar(['propietario']);
    const [carpeta] = await servicio.listarCarpetas({}, user);
    expect(carpeta).not.toHaveProperty('acls');
    expect(carpeta).not.toHaveProperty('permisos');
    expect(carpeta).not.toHaveProperty('permisosHeredados');
    expect(carpeta).not.toHaveProperty('heredaDe');
    expect(JSON.stringify(carpeta)).not.toContain(ROL_STAFF.toString());
  });

  it('sin unidades en la copropiedad no ve ninguna carpeta', async () => {
    const { servicio } = montar([]);
    await expect(servicio.listarCarpetas({}, user)).resolves.toEqual([]);
  });

  it('resuelve la tenencia con la copropiedad activa y la cuenta del llamante', async () => {
    const { servicio, portalAcceso } = montar(['propietario']);
    await servicio.listarCarpetas({}, user);
    expect(portalAcceso.unidadesDe).toHaveBeenCalledWith(
      CUENTA.toString(),
      COPROPIEDAD.toString(),
    );
  });

  it('un llamante sin cuenta identificable es 403', async () => {
    const { servicio } = montar(['propietario']);
    await expect(
      servicio.listarCarpetas({}, { uid: 'u', email: 'e@x.co' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('DocumentosPortalService.carpetaPorSlug y ruta', () => {
  it('una carpeta visible se devuelve', async () => {
    const { servicio } = montar(['propietario']);
    await expect(
      servicio.carpetaPorSlug('propietarios', user),
    ).resolves.toMatchObject({ slug: 'propietarios' });
  });

  it.each(['arrendatarios', 'solo-staff', 'privada', 'no-existe'])(
    'la carpeta %s es 404 para un propietario (mismo error que si no existiera)',
    async (slug) => {
      const { servicio } = montar(['propietario']);
      await expect(servicio.carpetaPorSlug(slug, user)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    },
  );

  it('ruta: una carpeta no visible o un id mal formado es 404', async () => {
    const { servicio } = montar(['propietario']);
    await expect(
      servicio.ruta(ARRENDATARIOS._id.toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(servicio.ruta('xyz', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('ruta: deja fuera los ancestros que el residente no puede leer', async () => {
    const padre = carpeta('padre-interno', [
      { tipo: 'rol', rolId: ROL_STAFF, puedeLeer: true, puedeEscribir: false },
    ]);
    const hija = carpeta('hija', [paraResidentes('todos')], {
      carpetaPadreId: padre._id,
    });
    const archivos = {
      aggregate: jest.fn().mockReturnValue(consulta([])),
    };
    const tenant = {
      resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
    };
    const carpetas = new CarpetasService(
      { find: jest.fn().mockReturnValue(consulta([padre, hija])) } as never,
      archivos as never,
      {} as never,
      tenant as never,
      {} as never,
    );
    const servicio = new DocumentosPortalService(
      archivos as never,
      tenant as never,
      carpetas,
      {
        unidadesDe: jest.fn().mockResolvedValue([{ rol: 'propietario' }]),
      } as never,
      {} as never,
    );

    const res = await servicio.ruta(hija._id.toString(), user);

    expect(res.map((r) => r.slug)).toEqual(['hija']);
  });
});

describe('DocumentosPortalService.listarDocumentos', () => {
  it('consulta solo las carpetas legibles y solo archivos listos de la copropiedad', async () => {
    const { servicio, archivos } = montar(['propietario']);
    await servicio.listarDocumentos({}, user);
    const filtro = (archivos.find.mock.calls as unknown[][])[0][0] as {
      copropiedadId: Types.ObjectId;
      estado: string;
      carpetaId: { $in: Types.ObjectId[] };
    };
    expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    expect(filtro.estado).toBe('listo');
    expect(filtro.carpetaId.$in.map(String).sort()).toEqual(
      [PROPIETARIOS._id, TODOS._id].map(String).sort(),
    );
  });

  it('pedir una carpeta no legible es 404 y no consulta archivos', async () => {
    const { servicio, archivos } = montar(['arrendatario']);
    await expect(
      servicio.listarDocumentos({ carpeta: 'propietarios' }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(archivos.find).not.toHaveBeenCalled();
  });

  it('la ubicación de un documento no revela ancestros que el residente no ve', async () => {
    const padre = carpeta('padre-interno', [
      { tipo: 'rol', rolId: ROL_STAFF, puedeLeer: true, puedeEscribir: false },
    ]);
    const hija = carpeta('hija', [paraResidentes('todos')], {
      carpetaPadreId: padre._id,
      nombre: 'Hija',
    });
    const archivos = {
      find: jest.fn().mockReturnValue(consulta([archivoDoc(hija._id)])),
    };
    const tenant = {
      resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
    };
    const carpetas = new CarpetasService(
      { find: jest.fn().mockReturnValue(consulta([padre, hija])) } as never,
      archivos as never,
      {} as never,
      tenant as never,
      {} as never,
    );
    const servicio = new DocumentosPortalService(
      archivos as never,
      tenant as never,
      carpetas,
      {
        unidadesDe: jest.fn().mockResolvedValue([{ rol: 'propietario' }]),
      } as never,
      {} as never,
    );

    const [res] = await servicio.listarDocumentos({}, user);

    expect(res.ubicacion).toBe('Hija');
  });
});

describe('DocumentosPortalService.descargar', () => {
  it('firma la lectura solo de un archivo listo en una carpeta que el residente puede leer', async () => {
    const { servicio, archivos, almacen } = montar(['propietario']);
    const doc = archivoDoc(PROPIETARIOS._id);
    archivos.findOne.mockReturnValue(consulta(doc));

    const res = await servicio.descargar(doc._id.toString(), user);

    expect(archivos.findOne).toHaveBeenCalledWith({
      _id: doc._id.toString(),
      copropiedadId: COPROPIEDAD,
      estado: 'listo',
    });
    expect(almacen.firmarLectura).toHaveBeenCalledWith(doc.rutaAlmacenamiento);
    expect(res).toEqual({
      url: 'https://storage/lectura',
      nombre: 'Reglamento.pdf',
    });
  });

  it('un archivo de una carpeta que no puede ver es 404 y no se firma nada', async () => {
    const { servicio, archivos, almacen } = montar(['arrendatario']);
    archivos.findOne.mockReturnValue(consulta(archivoDoc(PROPIETARIOS._id)));
    await expect(
      servicio.descargar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(almacen.firmarLectura).not.toHaveBeenCalled();
  });

  it('un archivo de una carpeta solo-personal es 404 incluso para propietarios', async () => {
    const { servicio, archivos, almacen } = montar(['propietario']);
    archivos.findOne.mockReturnValue(consulta(archivoDoc(SOLO_STAFF._id)));
    await expect(
      servicio.descargar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(almacen.firmarLectura).not.toHaveBeenCalled();
  });

  it('un documento inexistente, pendiente o de otra copropiedad es 404', async () => {
    const { servicio, almacen } = montar(['propietario']);
    await expect(
      servicio.descargar(new Types.ObjectId().toString(), user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(almacen.firmarLectura).not.toHaveBeenCalled();
  });

  it('un id mal formado es 404 sin consultar', async () => {
    const { servicio, archivos } = montar(['propietario']);
    await expect(servicio.descargar('xyz', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(archivos.findOne).not.toHaveBeenCalled();
  });
});

describe('DocumentosPortalService — solo lectura', () => {
  it('no expone ningún método de escritura (crear, subir, editar ni borrar)', () => {
    const metodos = Object.getOwnPropertyNames(
      DocumentosPortalService.prototype,
    ).filter((m) => m !== 'constructor');
    expect(
      metodos.filter((m) =>
        /crear|iniciar|confirmar|subir|actualizar|eliminar|guardar/i.test(m),
      ),
    ).toEqual([]);
  });
});

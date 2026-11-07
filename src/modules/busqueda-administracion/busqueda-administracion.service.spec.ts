import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import type { DocumentosActorService } from '../documentos/documentos-actor.service';
import { BusquedaAdministracionService } from './busqueda-administracion.service';

const COPROPIEDAD = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const ROL = new Types.ObjectId();

/** `find().sort().limit().lean().exec()` chain double. */
const cadena = (filas: unknown[]) => {
  const q = {
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn().mockResolvedValue(filas),
  };
  q.sort.mockReturnValue(q);
  q.limit.mockReturnValue(q);
  q.lean.mockReturnValue(q);
  return q;
};

/** The query double the n-th call of `find` returned. */
const resultado = (m: jest.Mock, n: number): ReturnType<typeof cadena> =>
  (m.mock.results[n] as { value: ReturnType<typeof cadena> }).value;

const modelo = (filas: unknown[] = []) => ({
  find: jest.fn().mockReturnValue(cadena(filas)),
});

const usuario = (
  permissions: string[],
  extra: Partial<IRequestUser> = {},
): IRequestUser => ({
  uid: 'uid',
  email: 'a@b.co',
  accountId: CUENTA.toString(),
  permissions,
  ...extra,
});

/** One read key per searchable subject, plus the Finanzas key of block billing. */
const TODOS = [
  'tareas.ver',
  'anuncios.ver',
  'pqr.ver',
  'mantenimientos.ver',
  'actividades.ver',
  'documentos-administracion.ver',
  'zonas.ver',
  'reservas.ver',
  'facturas.crear',
];

const carpeta = (
  slug: string,
  acls: unknown[] = [],
  carpetaPadreId: Types.ObjectId | null = null,
) => ({ _id: new Types.ObjectId(), slug, carpetaPadreId, acls });

const reglaDeRol = (rolId: Types.ObjectId, puedeLeer = true) => ({
  tipo: 'rol',
  rolId,
  puedeLeer,
  puedeEscribir: false,
});

describe('BusquedaAdministracionService', () => {
  let m: Record<
    | 'tareas'
    | 'anuncios'
    | 'pqrs'
    | 'mantenimientos'
    | 'actividades'
    | 'archivos'
    | 'carpetas'
    | 'zonas'
    | 'reservas'
    | 'bloques',
    ReturnType<typeof modelo>
  >;
  let tenant: { resolveCoPropertyId: jest.Mock };
  let actores: { deSolicitud: jest.Mock };
  let service: BusquedaAdministracionService;

  beforeEach(() => {
    m = {
      tareas: modelo(),
      anuncios: modelo(),
      pqrs: modelo(),
      mantenimientos: modelo(),
      actividades: modelo(),
      archivos: modelo(),
      carpetas: modelo(),
      zonas: modelo(),
      reservas: modelo(),
      bloques: modelo(),
    };
    tenant = { resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD) };
    actores = {
      deSolicitud: jest.fn().mockResolvedValue({
        roleIds: new Set([ROL.toString()]),
        gestiona: false,
      }),
    };
    service = new BusquedaAdministracionService(
      m.tareas as never,
      m.anuncios as never,
      m.pqrs as never,
      m.mantenimientos as never,
      m.actividades as never,
      m.archivos as never,
      m.carpetas as never,
      m.zonas as never,
      m.reservas as never,
      m.bloques as never,
      tenant as unknown as TenantContextService,
      new CaslAbilityFactory(),
      actores as unknown as DocumentosActorService,
    );
  });

  const sinConsultas = () => {
    for (const modeloActual of Object.values(m)) {
      expect(modeloActual.find).not.toHaveBeenCalled();
    }
  };

  const filtroDe = (modeloActual: ReturnType<typeof modelo>) =>
    (modeloActual.find.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;

  describe('un grupo por permiso: clave ausente = sin permiso, [] = sin coincidencias', () => {
    it('con todo permitido y sin datos, todas las claves están y valen []', async () => {
      const r = await service.buscar(usuario(TODOS), { q: 'febrero' });

      // No folder at all: documents answer [] without querying any file.
      expect(r).toEqual({
        tareas: [],
        anuncios: [],
        pqr: [],
        mantenimientos: [],
        actividades: [],
        documentos: [],
        zonasComunes: [],
        reservas: [],
        facturasBloque: [],
      });
      expect(m.archivos.find).not.toHaveBeenCalled();
    });

    it('solo pqr.ver: devuelve únicamente "pqr" y no toca los otros modelos', async () => {
      m.pqrs.find.mockReturnValue(
        cadena([
          {
            _id: new Types.ObjectId(),
            titulo: 'Gotera',
            descripcion: 'Piso 3',
          },
        ]),
      );

      const r = await service.buscar(usuario(['pqr.ver']), { q: 'gotera' });

      expect(Object.keys(r)).toEqual(['pqr']);
      expect(r.pqr).toHaveLength(1);
      expect(m.tareas.find).not.toHaveBeenCalled();
      expect(m.reservas.find).not.toHaveBeenCalled();
      expect(m.anuncios.find).not.toHaveBeenCalled();
      expect(m.carpetas.find).not.toHaveBeenCalled();
      expect(actores.deSolicitud).not.toHaveBeenCalled();
    });

    it('sin ningún permiso devuelve {} sin consultar', async () => {
      const r = await service.buscar(usuario([]), { q: 'febrero' });

      expect(r).toEqual({});
      sinConsultas();
    });

    it.each([
      ['tareas.ver', 'tareas'],
      ['anuncios.ver', 'anuncios'],
      ['pqr.ver', 'pqr'],
      ['mantenimientos.ver', 'mantenimientos'],
      ['actividades.ver', 'actividades'],
      ['zonas.ver', 'zonasComunes'],
      ['reservas.ver', 'reservas'],
      ['facturas.crear', 'facturasBloque'],
    ])('%s habilita únicamente el grupo %s', async (permiso, grupo) => {
      const r = await service.buscar(usuario([permiso]), { q: 'abc' });

      expect(Object.keys(r)).toEqual([grupo]);
    });

    it('documentos-administracion (ver o subir) habilita documentos pero no facturas por bloque (que pide facturas.crear)', async () => {
      const r = await service.buscar(
        usuario(['documentos-administracion.ver', 'documentos-administracion.subir']),
        { q: 'abc' },
      );

      expect(Object.keys(r)).toEqual(['documentos']);
    });

    it('los permisos financieros no abren nada aquí', async () => {
      const r = await service.buscar(
        usuario(['facturas.ver', 'recibos.ver', 'inmuebles.ver']),
        { q: 'abc' },
      );

      expect(r).toEqual({});
      sinConsultas();
    });
  });

  describe('tenant', () => {
    it('todas las consultas llevan la copropiedad activa del contexto', async () => {
      m.carpetas.find.mockReturnValue(
        cadena([carpeta('reglamentos', [reglaDeRol(ROL)])]),
      );

      await service.buscar(usuario(TODOS), { q: 'febrero' });

      expect(tenant.resolveCoPropertyId).toHaveBeenCalledTimes(1);
      for (const modeloActual of Object.values(m)) {
        expect(modeloActual.find).toHaveBeenCalledTimes(1);
        expect(filtroDe(modeloActual).copropiedadId).toBe(COPROPIEDAD);
      }
    });

    it('sin copropiedad activa el tenant lanza antes de cualquier consulta', async () => {
      tenant.resolveCoPropertyId.mockImplementation(() => {
        throw new Error('sin tenant');
      });

      await expect(
        service.buscar(usuario(TODOS), { q: 'febrero' }),
      ).rejects.toThrow('sin tenant');
      sinConsultas();
    });
  });

  describe('texto del usuario', () => {
    it('escapa los metacaracteres antes de armar la expresión regular', async () => {
      await service.buscar(usuario(['anuncios.ver']), { q: '(a.*)+[x]' });

      const or = filtroDe(m.anuncios).$or as Array<
        Record<string, { $regex: string; $options: string }>
      >;
      expect(or[0].titulo.$regex).toBe('\\(a\\.\\*\\)\\+\\[x\\]');
      expect(or[0].titulo.$options).toBe('i');
      // The pattern must compile and match the literal text, not behave as regex.
      const rx = new RegExp(or[0].titulo.$regex, 'i');
      expect(rx.test('(a.*)+[x]')).toBe(true);
      expect(rx.test('aaaa')).toBe(false);
    });

    it('usa el mismo patrón en todos los campos de cada grupo', async () => {
      await service.buscar(usuario(['pqr.ver']), { q: 'ana' });

      const or = filtroDe(m.pqrs).$or as Array<Record<string, unknown>>;
      expect(or.map((c) => Object.keys(c)[0])).toEqual([
        'titulo',
        'descripcion',
        'descripcionCompleta',
        'categoria',
        'codigo',
        'residente.nombre',
      ]);
      expect(
        new Set(or.map((c) => JSON.stringify(Object.values(c)[0]))).size,
      ).toBe(1);
    });

    it('limita cada grupo a 5 por defecto y respeta el límite pedido, ordenando por lo último modificado', async () => {
      await service.buscar(usuario(['anuncios.ver']), { q: 'ana' });
      await service.buscar(usuario(['anuncios.ver']), { q: 'ana', limite: 12 });

      const primera = resultado(m.anuncios.find, 0);
      const segunda = resultado(m.anuncios.find, 1);
      expect(primera.limit).toHaveBeenCalledWith(5);
      expect(segunda.limit).toHaveBeenCalledWith(12);
      expect(primera.sort).toHaveBeenCalledWith({ updatedAt: -1, _id: -1 });
    });
  });

  describe('tareas: un no gestor solo encuentra las suyas', () => {
    it('quien tiene tareas.gestionar busca en todas las de la copropiedad', async () => {
      await service.buscar(usuario(['tareas.ver', 'tareas.gestionar']), {
        q: 'pintar',
      });

      expect(filtroDe(m.tareas).asignadosIds).toBeUndefined();
    });

    it('quien solo lee las busca entre las que tiene asignadas', async () => {
      await service.buscar(usuario(['tareas.ver']), { q: 'pintar' });

      expect(String(filtroDe(m.tareas).asignadosIds)).toBe(CUENTA.toString());
    });

    it('quien solo lee y no tiene cuenta legible no encuentra ninguna, sin consultar', async () => {
      const r = await service.buscar(
        usuario(['tareas.ver'], { accountId: 'no-es-id' }),
        { q: 'pintar' },
      );

      expect(r.tareas).toEqual([]);
      expect(m.tareas.find).not.toHaveBeenCalled();
    });
  });

  describe('documentos: respetan las reglas de carpeta', () => {
    const doc = (carpetaId: Types.ObjectId, nombre: string) => ({
      _id: new Types.ObjectId(),
      nombre,
      categoria: 'legal',
      carpetaId,
    });

    it('busca solo en las carpetas que el rol del usuario puede leer', async () => {
      const legible = carpeta('reglamentos', [reglaDeRol(ROL)]);
      const ajena = carpeta('finanzas', [reglaDeRol(new Types.ObjectId())]);
      const sinReglas = carpeta('privada');
      m.carpetas.find.mockReturnValue(cadena([legible, ajena, sinReglas]));

      await service.buscar(usuario(['documentos-administracion.ver']), {
        q: 'acta',
      });

      const filtro = filtroDe(m.archivos);
      expect(filtro.carpetaId).toEqual({ $in: [legible._id] });
      expect(filtro.estado).toBe('listo');
      expect(filtro.copropiedadId).toBe(COPROPIEDAD);
    });

    it('una carpeta hija sin reglas hereda las del padre', async () => {
      const padre = carpeta('padre', [reglaDeRol(ROL)]);
      const hija = carpeta('hija', [], padre._id);
      m.carpetas.find.mockReturnValue(cadena([padre, hija]));

      await service.buscar(usuario(['documentos-administracion.ver']), {
        q: 'acta',
      });

      expect(
        (filtroDe(m.archivos).carpetaId as { $in: Types.ObjectId[] }).$in
          .map(String)
          .sort(),
      ).toEqual([padre._id, hija._id].map(String).sort());
    });

    it('una regla de rol que no permite leer no abre la carpeta', async () => {
      m.carpetas.find.mockReturnValue(
        cadena([carpeta('cerrada', [reglaDeRol(ROL, false)])]),
      );

      const r = await service.buscar(
        usuario(['documentos-administracion.ver']),
        {
          q: 'acta',
        },
      );

      expect(r.documentos).toEqual([]);
      expect(m.archivos.find).not.toHaveBeenCalled();
    });

    it('sin ninguna carpeta legible no consulta archivos y responde []', async () => {
      m.carpetas.find.mockReturnValue(
        cadena([carpeta('finanzas', [reglaDeRol(new Types.ObjectId())])]),
      );

      const r = await service.buscar(
        usuario(['documentos-administracion.ver']),
        {
          q: 'acta',
        },
      );

      expect(r.documentos).toEqual([]);
      expect(m.archivos.find).not.toHaveBeenCalled();
    });

    it('quien gestiona documentos busca en todas las carpetas', async () => {
      actores.deSolicitud.mockResolvedValue({
        roleIds: new Set(),
        gestiona: true,
      });
      const a = carpeta('a', [reglaDeRol(new Types.ObjectId())]);
      const b = carpeta('b');
      m.carpetas.find.mockReturnValue(cadena([a, b]));

      await service.buscar(
        usuario([
          'documentos-administracion.ver',
          'documentos-administracion.gestionar',
        ]),
        { q: 'acta' },
      );

      expect(
        (filtroDe(m.archivos).carpetaId as { $in: Types.ObjectId[] }).$in,
      ).toHaveLength(2);
    });

    it('el hit enlaza a la carpeta del archivo y lo abre: /documentos?carpeta=<slug>&abrir=<id>', async () => {
      const legible = carpeta('reglamentos', [reglaDeRol(ROL)]);
      const archivo = doc(legible._id, 'Acta de asamblea');
      m.carpetas.find.mockReturnValue(cadena([legible]));
      m.archivos.find.mockReturnValue(cadena([archivo]));

      const r = await service.buscar(
        usuario(['documentos-administracion.ver']),
        {
          q: 'acta',
        },
      );

      expect(r.documentos).toEqual([
        {
          id: archivo._id.toString(),
          tipo: 'documento',
          titulo: 'Acta de asamblea',
          descripcion: 'legal',
          ruta: `/documentos?carpeta=reglamentos&abrir=${archivo._id.toString()}`,
        },
      ]);
    });

    it('la lista de carpetas se resuelve con el id del actor del contexto, no con el de otra cuenta', async () => {
      m.carpetas.find.mockReturnValue(cadena([]));
      const u = usuario(['documentos-administracion.ver']);

      await service.buscar(u, { q: 'acta' });

      expect(actores.deSolicitud).toHaveBeenCalledWith(u);
    });
  });

  describe('hits: tipo, título y ruta', () => {
    it('cada grupo mapea a su ruta con ?abrir=<id>', async () => {
      const id = new Types.ObjectId();
      const ids = id.toString();
      m.tareas.find.mockReturnValue(
        cadena([{ _id: id, titulo: 'T', descripcion: 'd' }]),
      );
      m.anuncios.find.mockReturnValue(
        cadena([{ _id: id, titulo: 'A', contenido: 'c' }]),
      );
      m.pqrs.find.mockReturnValue(
        cadena([
          {
            _id: id,
            titulo: 'P',
            descripcion: '',
            descripcionCompleta: 'larga',
          },
        ]),
      );
      m.mantenimientos.find.mockReturnValue(cadena([{ _id: id, titulo: 'M' }]));
      m.actividades.find.mockReturnValue(cadena([{ _id: id, titulo: 'Ac' }]));
      m.zonas.find.mockReturnValue(cadena([{ _id: id, nombre: 'Piscina' }]));
      m.reservas.find.mockReturnValue(
        cadena([{ _id: id, residente: '', unidad: '304', motivo: null }]),
      );
      m.bloques.find.mockReturnValue(
        cadena([{ _id: id, nombre: 'Facturas julio', periodo: '2026-07' }]),
      );

      const r = await service.buscar(usuario(TODOS), { q: 'abc' });

      expect(r.tareas?.[0]).toMatchObject({
        tipo: 'tarea',
        ruta: `/tareas?abrir=${ids}`,
      });
      expect(r.anuncios?.[0]).toMatchObject({
        tipo: 'anuncio',
        ruta: `/anuncios?abrir=${ids}`,
      });
      expect(r.pqr?.[0]).toMatchObject({
        tipo: 'pqr',
        descripcion: 'larga',
        ruta: `/pqr?abrir=${ids}`,
      });
      expect(r.mantenimientos?.[0].ruta).toBe(`/mantenimientos?abrir=${ids}`);
      expect(r.actividades?.[0].ruta).toBe(`/actividades?abrir=${ids}`);
      expect(r.zonasComunes?.[0]).toMatchObject({
        tipo: 'zonaComun',
        titulo: 'Piscina',
      });
      expect(r.reservas?.[0]).toMatchObject({
        tipo: 'reserva',
        titulo: '304',
        ruta: `/reservas?abrir=${ids}`,
      });
      expect(r.facturasBloque?.[0]).toMatchObject({
        tipo: 'facturaBloque',
        titulo: 'Facturas julio',
        descripcion: '2026-07',
      });
    });

    it('la descripción larga se recorta a 120 caracteres con puntos suspensivos', async () => {
      m.anuncios.find.mockReturnValue(
        cadena([
          {
            _id: new Types.ObjectId(),
            titulo: 'A',
            contenido: 'x'.repeat(200),
          },
        ]),
      );

      const r = await service.buscar(usuario(['anuncios.ver']), { q: 'abc' });

      expect(r.anuncios?.[0].descripcion).toBe(`${'x'.repeat(120)}...`);
    });
  });
});

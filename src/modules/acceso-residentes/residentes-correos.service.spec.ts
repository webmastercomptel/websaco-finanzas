import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { claveCorreo } from '../../common/utils/email.utils';
import { ResidentesCorreosService } from './residentes-correos.service';

const COP = new Types.ObjectId();
const OTRA_COP = new Types.ObjectId();

interface TerceroFake {
  _id: Types.ObjectId;
  copropiedadId: Types.ObjectId;
  nombre: string;
  emails: string[];
  accountId: Types.ObjectId | null;
  estado: 'active' | 'inactive';
}

interface InmuebleFake {
  _id: Types.ObjectId;
  copropiedadId: Types.ObjectId;
  codigo: string;
  estado: 'active' | 'inactive';
  titularId: Types.ObjectId | null;
  arrendatarioId: Types.ObjectId | null;
}

interface CuentaFake {
  _id: Types.ObjectId;
  email: string;
  correoProbadoClave: string | null;
  ultimoIngresoPortalEn: Date | null;
}

const tercero = (over: Partial<TerceroFake> = {}): TerceroFake => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  nombre: 'Ana Pérez',
  emails: ['ana@correo.co'],
  accountId: null,
  estado: 'active',
  ...over,
});

const inmueble = (
  titular: TerceroFake | null,
  over: Partial<InmuebleFake> = {},
): InmuebleFake => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  codigo: '101',
  estado: 'active',
  titularId: titular?._id ?? null,
  arrendatarioId: null,
  ...over,
});

const cuenta = (over: Partial<CuentaFake> = {}): CuentaFake => ({
  _id: new Types.ObjectId(),
  email: 'ana@correo.co',
  correoProbadoClave: null,
  ultimoIngresoPortalEn: null,
  ...over,
});

const mismo = (a: unknown, b: unknown): boolean => String(a) === String(b);

/** A chainable query that answers what the callback computes at `exec` time. */
const consulta = <T>(resultado: () => T) => {
  const q = {
    select: () => q,
    sort: () => q,
    lean: () => q,
    exec: () => Promise.resolve(resultado()),
  };
  return q;
};

interface Opciones {
  terceros?: TerceroFake[];
  inmuebles?: InmuebleFake[];
  cuentas?: CuentaFake[];
  /** `clave`s revoked in the active coproperty. */
  revocadas?: string[];
  /** Normalized address -> reason. */
  genericos?: [string, 'correo-compartido'][];
}

function montar(opciones: Opciones = {}) {
  const terceros = opciones.terceros ?? [];
  const inmuebles = opciones.inmuebles ?? [];
  const cuentas = opciones.cuentas ?? [];
  const filtrosTerceros: Record<string, unknown>[] = [];
  const filtrosInmuebles: Record<string, unknown>[] = [];
  const filtrosCuentas: Record<string, unknown>[] = [];

  const modeloInmuebles = {
    find: jest.fn((filtro: Record<string, unknown>) => {
      filtrosInmuebles.push(filtro);
      return consulta(() =>
        inmuebles
          .filter(
            (u) =>
              mismo(u.copropiedadId, filtro.copropiedadId) &&
              u.estado === filtro.estado &&
              (u.titularId !== null || u.arrendatarioId !== null),
          )
          .sort((a, b) => a.codigo.localeCompare(b.codigo)),
      );
    }),
  };
  const modeloTerceros = {
    find: jest.fn((filtro: Record<string, unknown>) => {
      filtrosTerceros.push(filtro);
      const ids = (filtro._id as { $in: Types.ObjectId[] }).$in;
      return consulta(() =>
        terceros
          .filter(
            (t) =>
              mismo(t.copropiedadId, filtro.copropiedadId) &&
              t.estado === filtro.estado &&
              ids.some((id) => mismo(id, t._id)),
          )
          .sort((a, b) => a.nombre.localeCompare(b.nombre)),
      );
    }),
  };
  const modeloCuentas = {
    find: jest.fn((filtro: Record<string, unknown>) => {
      filtrosCuentas.push(filtro);
      const ramas = filtro.$or as Record<string, { $in: unknown[] }>[];
      return consulta(() =>
        cuentas.filter((c) =>
          ramas.some((r) =>
            r.email
              ? r.email.$in.includes(c.email)
              : r._id.$in.some((id) => mismo(id, c._id)),
          ),
        ),
      );
    }),
  };
  const tenant = { resolveCoPropertyId: jest.fn(() => COP) };
  const residencia = {
    clavesRevocadas: jest.fn(
      (claves: readonly string[], copropiedadId: string) => {
        void copropiedadId;
        return Promise.resolve(
          new Set(claves.filter((c) => (opciones.revocadas ?? []).includes(c))),
        );
      },
    ),
    motivosCorreoGenerico: jest.fn(() =>
      Promise.resolve(new Map(opciones.genericos ?? [])),
    ),
  };

  const servicio = new ResidentesCorreosService(
    modeloInmuebles as never,
    modeloTerceros as never,
    modeloCuentas as never,
    tenant as never,
    residencia as never,
  );
  return {
    servicio,
    modeloInmuebles,
    modeloTerceros,
    modeloCuentas,
    residencia,
    tenant,
    filtrosTerceros,
    filtrosInmuebles,
    filtrosCuentas,
  };
}

describe('ResidentesCorreosService.listar', () => {
  it('SEC: Residentes list is tenant-scoped', async () => {
    const mia = tercero({ nombre: 'Mía' });
    const ajena = tercero({ nombre: 'Ajena', copropiedadId: OTRA_COP });
    const m = montar({
      terceros: [mia, ajena],
      inmuebles: [
        inmueble(mia),
        inmueble(ajena, { copropiedadId: OTRA_COP, codigo: '900' }),
      ],
    });

    const r = await m.servicio.listar({});

    expect(r.items.map((f) => f.nombre)).toEqual(['Mía']);
    // Every read names the ACTIVE coproperty explicitly, as an ObjectId.
    for (const filtro of [...m.filtrosInmuebles, ...m.filtrosTerceros]) {
      expect(filtro.copropiedadId).toBe(COP);
    }
    expect(m.residencia.clavesRevocadas).toHaveBeenCalledWith(
      expect.any(Array),
      COP.toString(),
    );
  });

  it('un tercero de otra copropiedad con unidad de la mía no aparece', async () => {
    const forastero = tercero({ nombre: 'Forastero', copropiedadId: OTRA_COP });
    const m = montar({
      terceros: [forastero],
      // A unit of THIS coproperty that points at a party of another one.
      inmuebles: [inmueble(forastero)],
    });
    const r = await m.servicio.listar({});
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('un tercero que perdió su última unidad no se lista', async () => {
    const quedo = tercero({ nombre: 'Quedó' });
    const vendio = tercero({ nombre: 'Vendió' });
    const m = montar({
      terceros: [quedo, vendio],
      inmuebles: [
        inmueble(quedo),
        inmueble(vendio, { estado: 'inactive', codigo: '202' }),
      ],
    });
    const r = await m.servicio.listar({});
    expect(r.items.map((f) => f.nombre)).toEqual(['Quedó']);
  });

  it('arma las filas con estado, prueba, revocación y unidades por rol', async () => {
    const ana = tercero({ emails: ['ana@correo.co', 'b@correo.co'] });
    const beto = tercero({ nombre: 'Beto', emails: ['beto@correo.co'] });
    const entro = new Date('2026-10-02T10:00:00.000Z');
    const m = montar({
      terceros: [ana, beto],
      inmuebles: [
        inmueble(ana, { codigo: '101' }),
        inmueble(beto, {
          codigo: '202',
          titularId: null,
          arrendatarioId: beto._id,
        }),
      ],
      cuentas: [
        cuenta({
          correoProbadoClave: claveCorreo('ana@correo.co'),
          ultimoIngresoPortalEn: entro,
        }),
      ],
      revocadas: [claveCorreo('b@correo.co')],
    });

    const r = await m.servicio.listar({});

    expect(r.items.map((f) => [f.nombre, f.correo, f.estado])).toEqual([
      ['Ana Pérez', 'ana@correo.co', 'ingreso'],
      ['Ana Pérez', 'b@correo.co', 'revocado'],
      ['Beto', 'beto@correo.co', 'sin-ingreso'],
    ]);
    expect(r.items[0].ultimoIngresoEn).toBe(entro.toISOString());
    expect(r.items[2].unidades).toEqual([
      expect.objectContaining({ codigo: '202', rol: 'arrendatario' }),
    ]);
  });

  it('marca como a corregir los correos compartidos que le informa ResidenciaService', async () => {
    const t = tercero({ emails: ['porteria@correo.co'] });
    const m = montar({
      terceros: [t],
      inmuebles: [inmueble(t)],
      genericos: [['porteria@correo.co', 'correo-compartido']],
    });
    const r = await m.servicio.listar({});
    expect(r.items[0]).toMatchObject({
      requiereCorreccion: true,
      motivoCorreccion: 'correo-compartido',
    });
    // One batch call for the whole page, never one per address.
    expect(m.residencia.motivosCorreoGenerico).toHaveBeenCalledTimes(1);
  });

  it('una cuenta vinculada con otro correo aparece como acceso heredado', async () => {
    const c = cuenta({ email: 'viejo@correo.co' });
    const t = tercero({ emails: ['nuevo@correo.co'], accountId: c._id });
    const m = montar({
      terceros: [t],
      inmuebles: [inmueble(t)],
      cuentas: [c],
    });
    const r = await m.servicio.listar({});
    expect(r.items.map((f) => [f.correo, f.estado])).toEqual([
      ['nuevo@correo.co', 'sin-ingreso'],
      ['viejo@correo.co', 'heredado'],
    ]);
    expect(JSON.stringify(r)).not.toContain(c._id.toString());
  });

  it('busca, filtra por estado y pagina sobre las filas ya armadas', async () => {
    const a = tercero({ nombre: 'Ana', emails: ['ana@x.co'] });
    const b = tercero({ nombre: 'Beto', emails: ['beto@x.co'] });
    const c = tercero({ nombre: 'Carla', emails: ['carla@x.co'] });
    const m = montar({
      terceros: [a, b, c],
      inmuebles: [
        inmueble(a, { codigo: 'A1' }),
        inmueble(b, { codigo: 'B2' }),
        inmueble(c, { codigo: 'C3' }),
      ],
      revocadas: [claveCorreo('beto@x.co')],
    });

    expect((await m.servicio.listar({ buscar: 'b2' })).items).toHaveLength(1);
    expect(
      (await m.servicio.listar({ estado: 'revocado' })).items.map(
        (f) => f.nombre,
      ),
    ).toEqual(['Beto']);
    const p = await m.servicio.listar({ pagina: 2, porPagina: 2 });
    expect(p.items.map((f) => f.nombre)).toEqual(['Carla']);
    expect(p).toMatchObject({ total: 3, pagina: 2, porPagina: 2 });
  });

  it('el número de consultas no depende de cuántos terceros hay (sin N+1)', async () => {
    const contar = async (n: number) => {
      const personas = Array.from({ length: n }, (_, i) =>
        tercero({ nombre: `P${i}`, emails: [`p${i}@x.co`, `q${i}@x.co`] }),
      );
      const m = montar({
        terceros: personas,
        inmuebles: personas.map((p, i) => inmueble(p, { codigo: String(i) })),
        cuentas: personas.map((p, i) => cuenta({ email: `p${i}@x.co` })),
      });
      await m.servicio.listar({});
      return [
        m.modeloInmuebles.find.mock.calls.length,
        m.modeloTerceros.find.mock.calls.length,
        m.modeloCuentas.find.mock.calls.length,
        m.residencia.clavesRevocadas.mock.calls.length,
        m.residencia.motivosCorreoGenerico.mock.calls.length,
      ];
    };
    expect(await contar(3)).toEqual([1, 1, 1, 1, 1]);
    expect(await contar(30)).toEqual([1, 1, 1, 1, 1]);
  });

  it('sin unidades no consulta terceros, cuentas ni revocaciones', async () => {
    const m = montar({ terceros: [tercero()], inmuebles: [] });
    const r = await m.servicio.listar({});
    expect(r).toMatchObject({ items: [], total: 0, pagina: 1, porPagina: 50 });
    expect(m.modeloTerceros.find).not.toHaveBeenCalled();
    expect(m.modeloCuentas.find).not.toHaveBeenCalled();
    expect(m.residencia.clavesRevocadas).not.toHaveBeenCalled();
  });

  it('SEC: el correo nunca llega a un log', async () => {
    const espias = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
      (nivel) => jest.spyOn(Logger.prototype, nivel),
    );
    const t = tercero({ emails: ['secreto@correo.co'] });
    const m = montar({
      terceros: [t],
      inmuebles: [inmueble(t)],
      genericos: [['secreto@correo.co', 'correo-compartido']],
    });
    await m.servicio.listar({ buscar: 'secreto@correo.co' });
    const impreso = JSON.stringify(espias.flatMap((e) => e.mock.calls));
    expect(impreso).not.toContain('secreto@correo.co');
    espias.forEach((e) => e.mockRestore());
  });
});

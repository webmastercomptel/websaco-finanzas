import { Types } from 'mongoose';
import type {
  AccesoCopropiedad,
  AccesoService,
} from '../acceso/acceso.service';
import { DirectorioService } from './directorio.service';
import { claveCorreo } from '../utils/email.utils';

const oid = () => new Types.ObjectId();
const COP = oid();
const ENTIDAD = oid();

type Fila = Record<string, unknown>;

/** Stub of a query chain; every call in the service ends in `.lean().exec()`. */
const consulta = (filas: Fila[]) => {
  const lean = jest
    .fn()
    .mockReturnValue({ exec: () => Promise.resolve(filas) });
  const find = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({ lean }),
    lean,
  });
  const findOne = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({ lean }),
  });
  const findById = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: () => Promise.resolve(filas[0] ?? null),
      }),
    }),
  });
  return { find, findOne, findById };
};

const cuenta = (
  id: Types.ObjectId,
  nombreCompleto: string,
  extra: Fila = {},
) => ({
  _id: id,
  email: `${nombreCompleto.toLowerCase()}@ejemplo.com`,
  nombreCompleto,
  esAdministradorPlataforma: false,
  ...extra,
});

function acceso(permissions: string[], esResidente = false): AccesoCopropiedad {
  return {
    copropiedadId: COP.toString(),
    codigo: 'C-1',
    nombre: 'Edificio',
    permissions,
    modulos: ['finanzas', 'administracion'],
    esResidente,
  };
}

function crear(opciones: {
  cuentas?: Fila[];
  asignaciones?: Fila[];
  terceros?: Fila[];
  copropiedad?: Fila;
  inmuebles?: Fila[];
  accesos?: Record<string, AccesoCopropiedad | null>;
  /** Claves with an active revocation in COP (what `clavesRevocadas` answers). */
  revocadas?: string[];
  /** Generic inboxes (what `motivosCorreoGenerico` answers), by address. */
  genericos?: Record<string, string>;
}) {
  const inmuebles = consulta(opciones.inmuebles ?? []);
  const cuentas = consulta(opciones.cuentas ?? []);
  const asignaciones = consulta(opciones.asignaciones ?? []);
  const terceros = consulta(opciones.terceros ?? []);
  const copropiedades = consulta(
    opciones.copropiedad ? [opciones.copropiedad] : [{ entidadId: null }],
  );
  const accesoA = jest.fn((accountId: string) =>
    Promise.resolve(opciones.accesos?.[accountId] ?? null),
  );
  const clavesRevocadas = jest.fn((claves: readonly string[]) =>
    Promise.resolve(
      new Set(claves.filter((c) => (opciones.revocadas ?? []).includes(c))),
    ),
  );
  const motivosCorreoGenerico = jest.fn((correos: readonly string[]) =>
    Promise.resolve(
      new Map(
        correos.flatMap((c) => {
          const motivo = opciones.genericos?.[c];
          return motivo ? [[c, motivo] as const] : [];
        }),
      ),
    ),
  );
  const servicio = new DirectorioService(
    cuentas as never,
    asignaciones as never,
    terceros as never,
    copropiedades as never,
    { accesoA } as unknown as AccesoService,
    inmuebles as never,
    { clavesRevocadas, motivosCorreoGenerico } as never,
  );
  return {
    servicio,
    cuentas,
    asignaciones,
    terceros,
    inmuebles,
    accesoA,
    clavesRevocadas,
    motivosCorreoGenerico,
  };
}

describe('DirectorioService.residentes', () => {
  it('devuelve las cuentas activas vinculadas a un tercero activo de ESA copropiedad', async () => {
    const ana = oid();
    const t1 = oid();
    const t2 = oid();
    const { servicio, terceros, cuentas } = crear({
      terceros: [
        { _id: t1, accountId: ana },
        { _id: t2, accountId: ana },
      ],
      inmuebles: [{ titularId: t1, arrendatarioId: t2 }],
      cuentas: [cuenta(ana, 'Ana')],
    });

    const resultado = await servicio.residentes(COP);

    expect(terceros.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      estado: 'active',
    });
    expect(cuentas.find).toHaveBeenCalledWith({
      _id: { $in: [ana] },
      estado: 'active',
    });
    expect(resultado).toEqual([
      {
        accountId: ana.toString(),
        email: 'ana@ejemplo.com',
        nombre: 'Ana',
        perfil: 'residente',
      },
    ]);
  });

  it('ex propietario o ex arrendatario (vinculado pero sin unidad vigente) no recibe avisos', async () => {
    const ana = oid();
    const beto = oid();
    const tAna = oid();
    const tBeto = oid();
    const { servicio, inmuebles, cuentas } = crear({
      terceros: [
        { _id: tAna, accountId: ana },
        { _id: tBeto, accountId: beto },
      ],
      inmuebles: [{ titularId: oid(), arrendatarioId: tBeto }],
      cuentas: [cuenta(beto, 'Beto')],
    });

    const resultado = await servicio.residentes(COP);

    expect(inmuebles.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      estado: 'active',
      $or: [
        { titularId: { $in: [tAna, tBeto] } },
        { arrendatarioId: { $in: [tAna, tBeto] } },
      ],
    });
    expect(cuentas.find).toHaveBeenCalledWith({
      _id: { $in: [beto] },
      estado: 'active',
    });
    expect(resultado.map((r) => r.nombre)).toEqual(['Beto']);
  });

  it('sin terceros vinculados no consulta cuentas', async () => {
    const { servicio, cuentas } = crear({ terceros: [] });

    await expect(servicio.residentes(COP)).resolves.toEqual([]);
    expect(cuentas.find).not.toHaveBeenCalled();
  });
});

describe('DirectorioService.personalQueLeer', () => {
  it('toma asignaciones de la copropiedad Y de su entidad administradora', async () => {
    const { servicio, asignaciones } = crear({
      copropiedad: { entidadId: ENTIDAD },
      asignaciones: [],
    });

    await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(asignaciones.find).toHaveBeenCalledWith({
      estado: 'active',
      $or: [
        { alcance: 'copropiedad', copropiedadId: COP },
        { alcance: 'entidad', entidadId: ENTIDAD },
      ],
    });
  });

  it('sin entidad solo considera las asignaciones de la copropiedad', async () => {
    const { servicio, asignaciones } = crear({ asignaciones: [] });

    await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(asignaciones.find).toHaveBeenCalledWith({
      estado: 'active',
      $or: [{ alcance: 'copropiedad', copropiedadId: COP }],
    });
  });

  it('incluye solo a quien puede leer la materia con sus permisos efectivos', async () => {
    const puede = oid();
    const noPuede = oid();
    const { servicio } = crear({
      asignaciones: [{ accountId: puede }, { accountId: noPuede }],
      cuentas: [cuenta(puede, 'Luis'), cuenta(noPuede, 'Eva')],
      accesos: {
        [puede.toString()]: acceso(['tareas.ver']),
        [noPuede.toString()]: acceso(['pqr.ver']),
      },
    });

    const resultado = await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(resultado.map((d) => d.nombre)).toEqual(['Luis']);
    expect(resultado[0].perfil).toBe('personal');
  });

  it('un administrador de plataforma con asignación cuenta siempre', async () => {
    const root = oid();
    const { servicio } = crear({
      asignaciones: [{ accountId: root }],
      cuentas: [cuenta(root, 'Root', { esAdministradorPlataforma: true })],
      accesos: { [root.toString()]: acceso([]) },
    });

    const resultado = await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(resultado.map((d) => d.nombre)).toEqual(['Root']);
  });

  it('no repite a quien tiene varias asignaciones y omite al que perdió el acceso', async () => {
    const dos = oid();
    const sinAcceso = oid();
    const { servicio, accesoA } = crear({
      asignaciones: [
        { accountId: dos },
        { accountId: dos },
        { accountId: sinAcceso },
      ],
      cuentas: [cuenta(dos, 'Dos'), cuenta(sinAcceso, 'Nadie')],
      accesos: {
        [dos.toString()]: acceso(['tareas.gestionar']),
        [sinAcceso.toString()]: null,
      },
    });

    const resultado = await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(resultado.map((d) => d.nombre)).toEqual(['Dos']);
    expect(accesoA).toHaveBeenCalledTimes(2);
  });
});

describe('DirectorioService.destinatarioPorEmail', () => {
  const id = oid();

  it('busca la cuenta por correo en minúsculas y la trata como destinatario puntual', async () => {
    const { servicio, cuentas } = crear({
      cuentas: [cuenta(id, 'Mara')],
      accesos: { [id.toString()]: acceso(['mantenimientos.ver']) },
    });

    const resultado = await servicio.destinatarioPorEmail(
      ' MARA@Ejemplo.com ',
      COP,
      'Mantenimiento',
    );

    expect(cuentas.find).toHaveBeenCalledWith({ email: 'mara@ejemplo.com' });
    expect(resultado).toMatchObject({ perfil: 'personal', nombre: 'Mara' });
  });

  it('null cuando no existe una cuenta con ese correo, sin consultar accesos', async () => {
    const { servicio, accesoA } = crear({ cuentas: [] });

    await expect(
      servicio.destinatarioPorEmail('nadie@ejemplo.com', COP, 'Mantenimiento'),
    ).resolves.toBeNull();
    expect(accesoA).not.toHaveBeenCalled();
  });
});

describe('DirectorioService.destinatarioDe', () => {
  const id = oid();
  const cuentaActiva = [cuenta(id, 'Mara')];

  it('personal cuando sus permisos le dejan leer la materia', async () => {
    const { servicio } = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: acceso(['pqr.gestionar']) },
    });

    await expect(
      servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toMatchObject({ perfil: 'personal', nombre: 'Mara' });
  });

  it('residente cuando solo es titular o arrendatario (sin permisos)', async () => {
    const { servicio } = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: acceso([], true) },
    });

    await expect(
      servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toMatchObject({ perfil: 'residente' });
  });

  it('quien es personal y residente a la vez se trata como personal', async () => {
    const { servicio } = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: acceso(['pqr.ver'], true) },
    });

    await expect(
      servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toMatchObject({ perfil: 'personal' });
  });

  it('null sin acceso a la copropiedad, o con permisos que no alcanzan y sin ser residente', async () => {
    const sinAcceso = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: null },
    });
    const sinPermiso = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: acceso(['tareas.ver']) },
    });

    await expect(
      sinAcceso.servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toBeNull();
    await expect(
      sinPermiso.servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toBeNull();
  });

  it('null para una cuenta inactiva o inexistente', async () => {
    const { servicio } = crear({
      cuentas: [],
      accesos: { [id.toString()]: acceso(['pqr.ver']) },
    });

    await expect(
      servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toBeNull();
  });
});

describe('DirectorioService.residentesDeInmuebles', () => {
  const U1 = oid();
  const U2 = oid();

  it('devuelve al propietario Y al arrendatario de la unidad, cada uno con su rol en ella', async () => {
    const tPropietario = oid();
    const tArrendatario = oid();
    const ana = oid();
    const beto = oid();
    const { servicio } = crear({
      inmuebles: [
        { _id: U1, titularId: tPropietario, arrendatarioId: tArrendatario },
      ],
      terceros: [
        { _id: tPropietario, accountId: ana },
        { _id: tArrendatario, accountId: beto },
      ],
      cuentas: [cuenta(ana, 'Ana'), cuenta(beto, 'Beto')],
    });

    const resultado = await servicio.residentesDeInmuebles(COP, [U1]);

    expect(resultado.get(U1.toString())).toEqual([
      {
        accountId: ana.toString(),
        email: 'ana@ejemplo.com',
        nombre: 'Ana',
        perfil: 'residente',
        rol: 'propietario',
      },
      {
        accountId: beto.toString(),
        email: 'beto@ejemplo.com',
        nombre: 'Beto',
        perfil: 'residente',
        rol: 'arrendatario',
      },
    ]);
  });

  it('una unidad sin arrendatario devuelve solo al propietario, sin fallar', async () => {
    const tPropietario = oid();
    const ana = oid();
    const { servicio } = crear({
      inmuebles: [{ _id: U1, titularId: tPropietario, arrendatarioId: null }],
      terceros: [{ _id: tPropietario, accountId: ana }],
      cuentas: [cuenta(ana, 'Ana')],
    });

    const lista = (await servicio.residentesDeInmuebles(COP, [U1])).get(
      U1.toString(),
    );

    expect(lista?.map((r) => r.rol)).toEqual(['propietario']);
  });

  it('un tercero sin cuenta (o con la cuenta inactiva) se omite y la unidad queda con lista vacía', async () => {
    const tPropietario = oid();
    const tArrendatario = oid();
    const beto = oid();
    // El propietario no tiene cuenta: la consulta (accountId != null) no lo
    // devuelve. La cuenta del arrendatario está inactiva: tampoco aparece.
    const { servicio } = crear({
      inmuebles: [
        { _id: U1, titularId: tPropietario, arrendatarioId: tArrendatario },
      ],
      terceros: [{ _id: tArrendatario, accountId: beto }],
      cuentas: [],
    });

    const resultado = await servicio.residentesDeInmuebles(COP, [U1]);

    expect(resultado.get(U1.toString())).toEqual([]);
  });

  it('si propietario y arrendatario fueran la misma cuenta, aparece una sola vez como propietario', async () => {
    const tA = oid();
    const tB = oid();
    const ana = oid();
    const { servicio } = crear({
      inmuebles: [{ _id: U1, titularId: tA, arrendatarioId: tB }],
      terceros: [
        { _id: tA, accountId: ana },
        { _id: tB, accountId: ana },
      ],
      cuentas: [cuenta(ana, 'Ana')],
    });

    const lista = (await servicio.residentesDeInmuebles(COP, [U1])).get(
      U1.toString(),
    );

    expect(lista).toHaveLength(1);
    expect(lista?.[0].rol).toBe('propietario');
  });

  it('toda unidad pedida es clave del resultado, aunque no exista o sea de otra copropiedad', async () => {
    const { servicio, inmuebles, terceros } = crear({ inmuebles: [] });

    const resultado = await servicio.residentesDeInmuebles(COP, [U1, U2]);

    expect([...resultado.keys()].sort()).toEqual(
      [U1.toString(), U2.toString()].sort(),
    );
    expect(resultado.get(U1.toString())).toEqual([]);
    expect(inmuebles.find).toHaveBeenCalledWith({
      _id: { $in: [U1, U2] },
      copropiedadId: COP,
      estado: 'active',
    });
    expect(terceros.find).not.toHaveBeenCalled();
  });

  it('acota los terceros a la copropiedad y a los activos', async () => {
    const tPropietario = oid();
    const { servicio, terceros } = crear({
      inmuebles: [{ _id: U1, titularId: tPropietario, arrendatarioId: null }],
    });

    await servicio.residentesDeInmuebles(COP, [U1]);

    expect(terceros.find).toHaveBeenCalledWith({
      _id: { $in: [tPropietario] },
      copropiedadId: COP,
      estado: 'active',
    });
  });

  it('sin unidades pedidas no consulta nada', async () => {
    const { servicio, inmuebles } = crear({});

    await expect(servicio.residentesDeInmuebles(COP, [])).resolves.toEqual(
      new Map(),
    );
    expect(inmuebles.find).not.toHaveBeenCalled();
  });
});

/** `findOne(...).select(...).lean().exec()` resolving to a single row (or null). */
const unaFila = (fila: Fila | null) =>
  jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({ exec: () => Promise.resolve(fila) }),
    }),
  });

describe('DirectorioService.residentesDeInmueble', () => {
  it('resuelve la unidad por su código dentro de la copropiedad y devuelve sus residentes', async () => {
    const unidad = oid();
    const tPropietario = oid();
    const ana = oid();
    const { servicio, inmuebles } = crear({
      inmuebles: [
        { _id: unidad, titularId: tPropietario, arrendatarioId: null },
      ],
      terceros: [{ _id: tPropietario, accountId: ana }],
      cuentas: [cuenta(ana, 'Ana')],
    });
    inmuebles.findOne = unaFila({ _id: unidad });

    const lista = await servicio.residentesDeInmueble(COP, 'Torre A - 301');

    expect(inmuebles.findOne).toHaveBeenCalledWith({
      copropiedadId: COP,
      codigo: 'Torre A - 301',
      estado: 'active',
    });
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      accountId: ana.toString(),
      rol: 'propietario',
    });
  });

  it('un código que no existe en la copropiedad devuelve lista vacía', async () => {
    const { servicio, terceros, inmuebles } = crear({ inmuebles: [] });
    inmuebles.findOne = unaFila(null);

    await expect(servicio.residentesDeInmueble(COP, 'X-9')).resolves.toEqual(
      [],
    );
    expect(terceros.find).not.toHaveBeenCalled();
  });
});

/**
 * A model stub that APPLIES the filter (equality and `$in` on the keys the
 * recipients resolver uses), so a test can prove what a query would match
 * instead of trusting a fixed answer.
 */
const modeloFiltrante = (filas: Fila[]) => {
  const coincide = (fila: Fila, filtro: Fila): boolean =>
    Object.entries(filtro).every(([clave, esperado]) => {
      const valor = fila[clave];
      if (esperado && typeof esperado === 'object' && '$in' in esperado) {
        const lista = (esperado as { $in: unknown[] }).$in.map(String);
        return lista.includes(String(valor));
      }
      return String(valor) === String(esperado);
    });
  const find = jest.fn((filtro: Fila) => {
    const resultado = filas.filter((f) => coincide(f, filtro));
    const cadena = {
      select: () => cadena,
      lean: () => cadena,
      exec: () => Promise.resolve(resultado),
    };
    return cadena;
  });
  return { find };
};

describe('DirectorioService.correosDeInmuebles', () => {
  const COP_B = oid();

  const montar = (opciones: { unidades?: Fila[]; terceros?: Fila[] }) => {
    const residencia = {
      clavesRevocadas: jest.fn(() => Promise.resolve(new Set<string>())),
      revocacionesActivas: jest.fn(() => Promise.resolve(new Set<string>())),
    };
    const inmuebles = modeloFiltrante(opciones.unidades ?? []);
    const terceros = modeloFiltrante(opciones.terceros ?? []);
    const servicio = new DirectorioService(
      {} as never,
      {} as never,
      terceros as never,
      {} as never,
      {} as unknown as AccesoService,
      inmuebles as never,
      residencia as never,
    );
    return { servicio, inmuebles, terceros, residencia };
  };

  const unidad = (extra: Fila = {}) => ({
    _id: oid(),
    copropiedadId: COP,
    estado: 'active',
    titularId: null,
    arrendatarioId: null,
    ...extra,
  });
  const tercero = (extra: Fila = {}) => ({
    _id: oid(),
    copropiedadId: COP,
    estado: 'active',
    nombre: 'Ana',
    emails: ['ana@x.com'],
    accountId: null,
    ...extra,
  });

  it('devuelve las direcciones de la ficha del titular y del arrendatario, con una clave por cada inmueble pedido', async () => {
    const titular = tercero({ nombre: 'Ana', emails: ['a@x.com', 'b@x.com'] });
    const arrendatario = tercero({ nombre: 'Luis', emails: ['l@x.com'] });
    const u1 = unidad({
      titularId: titular._id,
      arrendatarioId: arrendatario._id,
    });
    const u2 = unidad();
    const { servicio } = montar({
      unidades: [u1, u2],
      terceros: [titular, arrendatario],
    });

    const mapa = await servicio.correosDeInmuebles(COP, [u1._id, u2._id]);

    expect(mapa.get(u1._id.toString())?.map((d) => [d.email, d.rol])).toEqual([
      ['a@x.com', 'propietario'],
      ['b@x.com', 'propietario'],
      ['l@x.com', 'arrendatario'],
    ]);
    expect(mapa.get(u2._id.toString())).toEqual([]);
  });

  it('el correo de acceso de una cuenta vinculada que no está en la ficha NO es un destino, y no se filtra por cuenta', async () => {
    const titular = tercero({ emails: ['ficha@x.com'], accountId: oid() });
    const u = unidad({ titularId: titular._id });
    const { servicio, terceros } = montar({
      unidades: [u],
      terceros: [titular],
    });

    const mapa = await servicio.correosDeInmuebles(COP, [u._id]);

    expect(mapa.get(u._id.toString())?.map((d) => d.email)).toEqual([
      'ficha@x.com',
    ]);
    const filtro = terceros.find.mock.calls[0][0];
    expect(filtro).not.toHaveProperty('accountId');
    expect(filtro).toMatchObject({ copropiedadId: COP, estado: 'active' });
  });

  it('con arrendatario inactivo recibe solo el titular; con la unidad inactiva no hay destinos', async () => {
    const titular = tercero({ emails: ['a@x.com'] });
    const arrendatario = tercero({ emails: ['l@x.com'], estado: 'inactive' });
    const activa = unidad({
      titularId: titular._id,
      arrendatarioId: arrendatario._id,
    });
    const inactiva = unidad({ titularId: titular._id, estado: 'inactive' });
    const { servicio } = montar({
      unidades: [activa, inactiva],
      terceros: [titular, arrendatario],
    });

    const mapa = await servicio.correosDeInmuebles(COP, [
      activa._id,
      inactiva._id,
    ]);

    expect(mapa.get(activa._id.toString())?.map((d) => d.email)).toEqual([
      'a@x.com',
    ]);
    expect(mapa.get(inactiva._id.toString())).toEqual([]);
  });

  it('SEC: correosDeInmuebles never crosses coproperty — un tercero de otra copropiedad no aporta nada y una unidad ajena no resuelve', async () => {
    const ajeno = tercero({ copropiedadId: COP_B, emails: ['ajeno@x.com'] });
    const uConAjeno = unidad({ titularId: ajeno._id });
    const uDeOtraCop = unidad({ copropiedadId: COP_B, titularId: ajeno._id });
    const { servicio, inmuebles, terceros } = montar({
      unidades: [uConAjeno, uDeOtraCop],
      terceros: [ajeno],
    });

    const mapa = await servicio.correosDeInmuebles(COP, [
      uConAjeno._id,
      uDeOtraCop._id,
    ]);

    expect(mapa.get(uConAjeno._id.toString())).toEqual([]);
    expect(mapa.get(uDeOtraCop._id.toString())).toEqual([]);
    expect(inmuebles.find.mock.calls[0][0]).toMatchObject({
      copropiedadId: COP,
    });
    expect(terceros.find.mock.calls[0][0]).toMatchObject({
      copropiedadId: COP,
    });
  });

  it('SEC: revoking the portal does not stop invoice e-mails (REVOCACION_DETIENE_CORREOS_FACTURA es false)', async () => {
    const titular = tercero({ emails: ['ana@x.com'] });
    const u = unidad({ titularId: titular._id });
    const { servicio, residencia } = montar({
      unidades: [u],
      terceros: [titular],
    });
    // Even if every address were revoked, the invoice recipients come from the
    // records alone.
    residencia.clavesRevocadas.mockResolvedValue(
      new Set([claveCorreo('ana@x.com')]),
    );
    residencia.revocacionesActivas.mockResolvedValue(new Set([COP.toString()]));

    const mapa = await servicio.correosDeInmuebles(COP, [u._id]);

    expect(mapa.get(u._id.toString())?.map((d) => d.email)).toEqual([
      'ana@x.com',
    ]);
    expect(residencia.clavesRevocadas).not.toHaveBeenCalled();
    expect(residencia.revocacionesActivas).not.toHaveBeenCalled();
  });

  it('sin inmuebles pedidos no consulta nada', async () => {
    const { servicio, inmuebles } = montar({});

    expect((await servicio.correosDeInmuebles(COP, [])).size).toBe(0);
    expect(inmuebles.find).not.toHaveBeenCalled();
  });
});

/** Notices follow the same derivation as the portal (REQ-N1). */
describe('DirectorioService residentes por dirección probada', () => {
  const U1 = oid();
  const claveAna = claveCorreo('ana@x.com');
  const probada = (id: Types.ObjectId, nombre: string, correo: string) =>
    cuenta(id, nombre, {
      email: correo,
      correoProbadoClave: claveCorreo(correo),
    });

  it('un residente probado cuya dirección está en el titular de una unidad vigente recibe los avisos (S-N1.1)', async () => {
    const ana = oid();
    const t = oid();
    const { servicio, cuentas } = crear({
      terceros: [{ _id: t, accountId: null, emails: ['Ana@X.com'] }],
      inmuebles: [{ titularId: t, arrendatarioId: null }],
      cuentas: [probada(ana, 'Ana', 'ana@x.com')],
    });

    const resultado = await servicio.residentes(COP);

    expect(resultado).toEqual([
      {
        accountId: ana.toString(),
        email: 'ana@x.com',
        nombre: 'Ana',
        perfil: 'residente',
      },
    ]);
    expect(cuentas.find).toHaveBeenCalledWith({
      email: { $in: ['ana@x.com'] },
      estado: 'active',
      correoProbadoClave: { $ne: null },
    });
  });

  it('la dirección revocada no recibe avisos, ni por prueba ni por vínculo heredado (S-N1.2)', async () => {
    const ana = oid();
    const beto = oid();
    const tAna = oid();
    const tBeto = oid();
    const { servicio, clavesRevocadas } = crear({
      terceros: [
        { _id: tAna, accountId: null, emails: ['ana@x.com'] },
        { _id: tBeto, accountId: beto, emails: [] },
      ],
      inmuebles: [{ titularId: tAna, arrendatarioId: tBeto }],
      cuentas: [probada(ana, 'Ana', 'ana@x.com'), cuenta(beto, 'Beto')],
      revocadas: [claveAna, claveCorreo('beto@ejemplo.com')],
    });

    await expect(servicio.residentes(COP)).resolves.toEqual([]);
    expect(clavesRevocadas).toHaveBeenCalledWith(
      expect.arrayContaining([claveAna, claveCorreo('beto@ejemplo.com')]),
      COP.toString(),
    );
  });

  it('el vínculo heredado sin revocación sigue recibiendo avisos (S-N1.3)', async () => {
    const beto = oid();
    const tBeto = oid();
    const { servicio } = crear({
      terceros: [{ _id: tBeto, accountId: beto }],
      inmuebles: [{ titularId: tBeto, arrendatarioId: null }],
      cuentas: [cuenta(beto, 'Beto')],
    });

    const resultado = await servicio.residentes(COP);

    expect(resultado.map((r) => r.nombre)).toEqual(['Beto']);
  });

  it('una prueba cuya dirección ya no está en el registro no recibe avisos (S-N1.4)', async () => {
    const ana = oid();
    const t = oid();
    const { servicio, cuentas } = crear({
      terceros: [{ _id: t, accountId: null, emails: ['otra@x.com'] }],
      inmuebles: [{ titularId: t, arrendatarioId: null }],
      cuentas: [probada(ana, 'Ana', 'ana@x.com')],
    });

    // The stub answers every query with the same rows; the rule keeps only
    // accounts whose own address is on a holder's record.
    await expect(servicio.residentes(COP)).resolves.toEqual([]);
    expect(cuentas.find).toHaveBeenCalledWith(
      expect.objectContaining({ email: { $in: ['otra@x.com'] } }),
    );
  });

  it('una prueba de otra dirección o una dirección guardada con espacios no cuentan', async () => {
    const ana = oid();
    const t = oid();
    const { servicio, cuentas } = crear({
      terceros: [{ _id: t, accountId: null, emails: [' ana@x.com '] }],
      inmuebles: [{ titularId: t, arrendatarioId: null }],
      cuentas: [
        cuenta(ana, 'Ana', {
          email: 'ana@x.com',
          correoProbadoClave: claveCorreo('otra@x.com'),
        }),
      ],
    });

    await expect(servicio.residentes(COP)).resolves.toEqual([]);
    // The padded value is not even a candidate address.
    expect(cuentas.find).not.toHaveBeenCalled();
  });

  it('una cuenta con vínculo heredado y prueba aparece una sola vez (S-N1.5)', async () => {
    const ana = oid();
    const t = oid();
    const { servicio } = crear({
      terceros: [{ _id: t, accountId: ana, emails: ['ana@x.com'] }],
      inmuebles: [{ titularId: t, arrendatarioId: null }],
      cuentas: [probada(ana, 'Ana', 'ana@x.com')],
    });

    const resultado = await servicio.residentes(COP);

    expect(resultado).toHaveLength(1);
  });

  it('por unidad: el propietario probado y el arrendatario heredado, cada uno con su rol; la misma cuenta en ambos lados va como propietario', async () => {
    const ana = oid();
    const beto = oid();
    const tA = oid();
    const tB = oid();
    const { servicio } = crear({
      inmuebles: [{ _id: U1, titularId: tA, arrendatarioId: tB }],
      terceros: [
        { _id: tA, accountId: null, emails: ['ana@x.com'] },
        { _id: tB, accountId: beto, emails: ['ana@x.com'] },
      ],
      cuentas: [probada(ana, 'Ana', 'ana@x.com'), cuenta(beto, 'Beto')],
    });

    const lista = (await servicio.residentesDeInmuebles(COP, [U1])).get(
      U1.toString(),
    );

    expect(lista?.map((r) => [r.nombre, r.rol])).toEqual([
      ['Ana', 'propietario'],
      ['Beto', 'arrendatario'],
    ]);
  });

  it('por unidad: dos direcciones del mismo propietario son dos cuentas y las revocadas se omiten', async () => {
    const ana = oid();
    const ana2 = oid();
    const t = oid();
    const { servicio } = crear({
      inmuebles: [{ _id: U1, titularId: t, arrendatarioId: null }],
      terceros: [{ _id: t, accountId: null, emails: ['ana@x.com', 'b@x.com'] }],
      cuentas: [
        probada(ana, 'Ana', 'ana@x.com'),
        probada(ana2, 'Bea', 'b@x.com'),
      ],
      revocadas: [claveCorreo('b@x.com')],
    });

    const lista = (await servicio.residentesDeInmuebles(COP, [U1])).get(
      U1.toString(),
    );

    expect(lista?.map((r) => r.nombre)).toEqual(['Ana']);
  });

  it('por unidad: el costo es constante en el número de unidades (terceros, cuentas y revocaciones, una vez cada uno)', async () => {
    const ana = oid();
    const t = oid();
    const { servicio, terceros, cuentas, clavesRevocadas } = crear({
      inmuebles: [
        { _id: U1, titularId: t, arrendatarioId: null },
        { _id: oid(), titularId: t, arrendatarioId: null },
      ],
      terceros: [{ _id: t, accountId: ana, emails: ['ana@x.com'] }],
      cuentas: [probada(ana, 'Ana', 'ana@x.com')],
    });

    await servicio.residentesDeInmuebles(COP, [U1]);

    expect(terceros.find).toHaveBeenCalledTimes(1);
    // Legacy lookup by id plus one lookup by proven address.
    expect(cuentas.find).toHaveBeenCalledTimes(2);
    expect(clavesRevocadas).toHaveBeenCalledTimes(1);
  });
});

describe('DirectorioService con un buzón genérico', () => {
  it('una dirección probada que es buzón genérico no llega a nadie por correo; el vínculo heredado sigue', async () => {
    const porteria = oid();
    const beto = oid();
    const tPorteria = oid();
    const tBeto = oid();
    const { servicio, motivosCorreoGenerico } = crear({
      terceros: [
        { _id: tPorteria, accountId: null, emails: ['porteria@x.com'] },
        { _id: tBeto, accountId: beto, emails: ['porteria@x.com'] },
      ],
      inmuebles: [{ titularId: tPorteria, arrendatarioId: tBeto }],
      cuentas: [
        cuenta(porteria, 'Porteria', {
          email: 'porteria@x.com',
          correoProbadoClave: claveCorreo('porteria@x.com'),
        }),
        cuenta(beto, 'Beto'),
      ],
      genericos: { 'porteria@x.com': 'correo-compartido' },
    });

    const resultado = await servicio.residentes(COP);

    expect(resultado.map((r) => r.nombre)).toEqual(['Beto']);
    expect(motivosCorreoGenerico).toHaveBeenCalledWith(['porteria@x.com']);
  });
});

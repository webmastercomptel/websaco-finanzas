import { Types } from 'mongoose';
import { AccesoService } from './acceso.service';

const oid = () => new Types.ObjectId();

const cuenta = oid();
const entidadA = oid();
const copA = oid();
const copB = oid();
const copC = oid();

type Fila = Record<string, unknown>;

/**
 * Chainable stub standing in for a Mongoose query. Every model call in the
 * service ends in `.lean().exec()`, so the whole chain resolves to `filas`.
 */
const consulta = (filas: Fila[]) => ({
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: () => Promise.resolve(filas) }),
      }),
      lean: jest.fn().mockReturnValue({ exec: () => Promise.resolve(filas) }),
    }),
    sort: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({ exec: () => Promise.resolve(filas) }),
    }),
    lean: jest.fn().mockReturnValue({ exec: () => Promise.resolve(filas) }),
  }),
});

const servicio = (opts: {
  asignaciones?: Fila[];
  copropiedades?: Fila[];
  entidades?: Fila[];
  terceros?: Fila[];
  roles?: ReturnType<typeof consulta> | Fila[];
  /**
   * Active units. Default: each linked Tercero currently holds one unit (as
   * owner) in its own coproperty, so a "resident" fixture means a current one.
   */
  inmuebles?: Fila[];
}) => {
  const terceros = (opts.terceros ?? []).map((t): Fila => ({
    _id: oid(),
    ...t,
  }));
  const inmuebles =
    opts.inmuebles ??
    terceros.map((t) => ({
      copropiedadId: t.copropiedadId,
      titularId: t._id,
      arrendatarioId: null,
    }));
  return new AccesoService(
    consulta(opts.asignaciones ?? []) as never,
    consulta(opts.copropiedades ?? []) as never,
    consulta(opts.entidades ?? []) as never,
    consulta(terceros) as never,
    (Array.isArray(opts.roles) || opts.roles === undefined
      ? consulta(opts.roles ?? [])
      : opts.roles) as never,
    consulta(inmuebles) as never,
  );
};

const copropiedad = (
  id: Types.ObjectId,
  codigo: string,
  entidad?: Types.ObjectId,
) => ({
  _id: id,
  codigo,
  nombre: `Edificio ${codigo}`,
  entidadId: entidad ?? null,
});

describe('AccesoService.copropiedadesDe', () => {
  it('devuelve vacío cuando la cuenta no tiene asignaciones', async () => {
    const service = servicio({ asignaciones: [] });

    await expect(service.copropiedadesDe(cuenta.toString())).resolves.toEqual(
      [],
    );
  });

  it('resuelve una asignación directa a una copropiedad', async () => {
    const service = servicio({
      asignaciones: [
        {
          alcance: 'copropiedad',
          copropiedadId: copA,
          permisos: ['facturas.ver'],
        },
      ],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const resultado = await service.copropiedadesDe(cuenta.toString());

    expect(resultado).toHaveLength(1);
    expect(resultado[0]).toMatchObject({
      copropiedadId: copA.toString(),
      codigo: 'COP-A',
      permissions: ['facturas.ver'],
    });
  });

  it('una asignación a una entidad alcanza todos sus edificios', async () => {
    // Este es el punto de la entidad: la empresa toma un edificio más y la
    // gente ya lo tiene, sin editar a nadie.
    const service = servicio({
      asignaciones: [
        {
          alcance: 'entidad',
          entidadId: entidadA,
          permisos: ['facturas.ver', 'recibos.crear'],
        },
      ],
      entidades: [{ _id: entidadA }],
      copropiedades: [
        copropiedad(copA, 'COP-A', entidadA),
        copropiedad(copB, 'COP-B', entidadA),
      ],
    });

    const resultado = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.map((c) => c.codigo).sort()).toEqual(['COP-A', 'COP-B']);
  });

  it('una entidad inactiva no otorga nada', async () => {
    // La consulta de entidades filtra por estado activo, así que no vuelve
    // ninguna: el acceso por esa vía desaparece.
    const service = servicio({
      asignaciones: [
        {
          alcance: 'entidad',
          entidadId: entidadA,
          permisos: ['facturas.ver'],
        },
      ],
      entidades: [],
      copropiedades: [copropiedad(copA, 'COP-A', entidadA)],
    });

    await expect(service.copropiedadesDe(cuenta.toString())).resolves.toEqual(
      [],
    );
  });

  it('ignora una asignación de alcance copropiedad sin id', async () => {
    // Fila mal armada: no debe romper la resolución del resto.
    const service = servicio({
      asignaciones: [
        { alcance: 'copropiedad', copropiedadId: null, permisos: ['x.y'] },
      ],
      copropiedades: [],
    });

    await expect(service.copropiedadesDe(cuenta.toString())).resolves.toEqual(
      [],
    );
  });

  it('descarta una copropiedad inactiva aunque esté asignada', async () => {
    // `describir` sólo trae las activas; la asignación existe pero no rinde.
    const service = servicio({
      asignaciones: [
        { alcance: 'copropiedad', copropiedadId: copC, permisos: ['x.y'] },
      ],
      copropiedades: [],
    });

    await expect(service.copropiedadesDe(cuenta.toString())).resolves.toEqual(
      [],
    );
  });

  it('el administrador de plataforma ve todo sin necesitar asignaciones', async () => {
    const service = servicio({
      asignaciones: [],
      copropiedades: [copropiedad(copA, 'COP-A'), copropiedad(copB, 'COP-B')],
    });

    const resultado = await service.copropiedadesDe(cuenta.toString(), true);

    expect(resultado).toHaveLength(2);
    // Sin permisos copiados: la fábrica de habilidades le concede todo por su
    // condición, no por arrastrar una copia de cada clave.
    expect(resultado[0].permissions).toEqual([]);
  });
});

describe('AccesoService.accesoA', () => {
  it('devuelve el acceso cuando la copropiedad está permitida', async () => {
    const service = servicio({
      asignaciones: [
        {
          alcance: 'copropiedad',
          copropiedadId: copA,
          permisos: ['facturas.ver'],
        },
      ],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    await expect(
      service.accesoA(cuenta.toString(), copA.toString()),
    ).resolves.toMatchObject({ codigo: 'COP-A' });
  });

  it('devuelve null para una copropiedad que no tiene asignada', async () => {
    const service = servicio({
      asignaciones: [
        { alcance: 'copropiedad', copropiedadId: copA, permisos: [] },
      ],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    await expect(
      service.accesoA(cuenta.toString(), copB.toString()),
    ).resolves.toBeNull();
  });

  it('devuelve null ante un id con formato inválido, sin consultar', async () => {
    // Un header basura tiene que fallar cerrado acá, no reventar más abajo con
    // un CastError que se ve como un 500.
    const service = servicio({ asignaciones: [] });

    await expect(
      service.accesoA(cuenta.toString(), 'no-es-un-object-id'),
    ).resolves.toBeNull();
  });
});

describe('AccesoService módulos contratados', () => {
  const asignacionA = {
    alcance: 'copropiedad',
    copropiedadId: copA,
    permisos: ['facturas.ver'],
  };

  it('expone los módulos que la copropiedad contrató', async () => {
    const service = servicio({
      asignaciones: [asignacionA],
      copropiedades: [
        {
          ...copropiedad(copA, 'COP-A'),
          modulosContratados: ['finanzas', 'administracion'],
        },
      ],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.modulos).toEqual(['finanzas', 'administracion']);
  });

  it('una copropiedad sin el campo es solo finanzas', async () => {
    const service = servicio({
      asignaciones: [asignacionA],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.modulos).toEqual(['finanzas']);
  });

  it('el administrador de plataforma recibe los módulos reales de cada copropiedad', async () => {
    const service = servicio({
      copropiedades: [
        {
          ...copropiedad(copA, 'COP-A'),
          modulosContratados: ['administracion'],
        },
      ],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString(), true);

    expect(resultado.modulos).toEqual(['administracion']);
  });
});

describe('AccesoService residentes (portal)', () => {
  const asignacionA = {
    alcance: 'copropiedad',
    copropiedadId: copA,
    permisos: ['facturas.ver'],
  };

  it('una cuenta solo residente ve su copropiedad con permisos vacíos', async () => {
    const service = servicio({
      terceros: [{ copropiedadId: copA }],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado).toMatchObject({
      copropiedadId: copA.toString(),
      permissions: [],
      esResidente: true,
    });
  });

  it('administrativa y residente en el mismo edificio conserva sus permisos', async () => {
    const service = servicio({
      asignaciones: [asignacionA],
      terceros: [{ copropiedadId: copA }],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const resultado = await service.copropiedadesDe(cuenta.toString());

    expect(resultado).toHaveLength(1);
    expect(resultado[0]).toMatchObject({
      permissions: ['facturas.ver'],
      esResidente: true,
    });
  });

  it('una cuenta administrativa que no es residente queda con esResidente false', async () => {
    const service = servicio({
      asignaciones: [asignacionA],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.esResidente).toBe(false);
  });

  it('solo cuentan los terceros activos de ESA cuenta', async () => {
    const terceros = consulta([{ _id: oid(), copropiedadId: copA }]);
    const service = new AccesoService(
      consulta([]) as never,
      consulta([copropiedad(copA, 'COP-A')]) as never,
      consulta([]) as never,
      terceros as never,
      consulta([]) as never,
      consulta([]) as never,
    );

    await service.copropiedadesDe(cuenta.toString());

    expect(terceros.find).toHaveBeenCalledWith({
      accountId: cuenta,
      estado: 'active',
    });
  });
});

describe('AccesoService residentes: tenencia VIGENTE, no solo vínculo', () => {
  const tercero = oid();

  it('ex propietario: el Tercero sigue vinculado pero ya no es titular de nada → sin portal', async () => {
    const service = servicio({
      terceros: [{ _id: tercero, copropiedadId: copA }],
      inmuebles: [],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    await expect(service.copropiedadesDe(cuenta.toString())).resolves.toEqual(
      [],
    );
  });

  it('ex arrendatario conserva el acceso administrativo pero pierde esResidente', async () => {
    const service = servicio({
      asignaciones: [
        { alcance: 'copropiedad', copropiedadId: copA, permisos: ['pqr.ver'] },
      ],
      terceros: [{ _id: tercero, copropiedadId: copA }],
      inmuebles: [],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.esResidente).toBe(false);
  });

  it('arrendatario vigente de una unidad activa sí es residente', async () => {
    const service = servicio({
      terceros: [{ _id: tercero, copropiedadId: copA }],
      inmuebles: [
        { copropiedadId: copA, titularId: oid(), arrendatarioId: tercero },
      ],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado).toMatchObject({
      copropiedadId: copA.toString(),
      esResidente: true,
    });
  });

  it('una unidad de OTRA copropiedad que apunte al Tercero no da portal en la suya', async () => {
    const service = servicio({
      terceros: [{ _id: tercero, copropiedadId: copA }],
      inmuebles: [{ copropiedadId: copB, titularId: tercero }],
      copropiedades: [copropiedad(copA, 'COP-A'), copropiedad(copB, 'COP-B')],
    });

    await expect(service.copropiedadesDe(cuenta.toString())).resolves.toEqual(
      [],
    );
  });

  it('busca solo unidades activas cuyo titular o arrendatario es uno de sus Terceros', async () => {
    const inmuebles = consulta([]);
    const service = new AccesoService(
      consulta([]) as never,
      consulta([]) as never,
      consulta([]) as never,
      consulta([{ _id: tercero, copropiedadId: copA }]) as never,
      consulta([]) as never,
      inmuebles as never,
    );

    await service.copropiedadesDe(cuenta.toString());

    expect(inmuebles.find).toHaveBeenCalledWith({
      estado: 'active',
      $or: [
        { titularId: { $in: [tercero] } },
        { arrendatarioId: { $in: [tercero] } },
      ],
    });
  });
});

describe('AccesoService roles (paquetes de permisos de Administración)', () => {
  const rolA = oid();
  const rolB = oid();
  const directa = (extra: Fila = {}) => ({
    alcance: 'copropiedad',
    copropiedadId: copA,
    permisos: ['facturas.ver'],
    roleIds: [rolA],
    ...extra,
  });
  const rol = (id: Types.ObjectId, permisos: string[], de = copA) => ({
    _id: id,
    copropiedadId: de,
    permisos,
  });

  it('une los permisos del rol con los directos de la asignación', async () => {
    const service = servicio({
      asignaciones: [directa()],
      copropiedades: [copropiedad(copA, 'COP-A')],
      roles: [rol(rolA, ['pqr.ver', 'tareas.gestionar'])],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect([...resultado.permissions].sort()).toEqual([
      'facturas.ver',
      'pqr.ver',
      'tareas.gestionar',
    ]);
  });

  it('solo cuentan los roles que la asignación nombra y que son de ESA copropiedad', async () => {
    const service = servicio({
      asignaciones: [directa()],
      copropiedades: [copropiedad(copA, 'COP-A')],
      roles: [rol(rolA, ['pqr.ver'], copB), rol(rolB, ['tareas.ver'], copA)],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.permissions).toEqual(['facturas.ver']);
  });

  it('un rol no puede aportar permisos de finanzas ni claves desconocidas', async () => {
    const service = servicio({
      asignaciones: [directa({ permisos: [] })],
      copropiedades: [copropiedad(copA, 'COP-A')],
      roles: [rol(rolA, ['facturas.anular', 'pqr.ver', 'inventada.ver'])],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.permissions).toEqual(['pqr.ver']);
  });

  it('el personal conserva los permisos de Administración de su rol', async () => {
    const service = servicio({
      asignaciones: [directa({ perfil: 'personal', permisos: [] })],
      copropiedades: [copropiedad(copA, 'COP-A')],
      roles: [rol(rolA, ['mantenimientos.ver'])],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.permissions).toEqual(['mantenimientos.ver']);
  });

  it('una asignación por entidad ignora los roles: son de una copropiedad', async () => {
    const service = servicio({
      asignaciones: [
        {
          alcance: 'entidad',
          entidadId: entidadA,
          permisos: ['facturas.ver'],
          roleIds: [rolA],
        },
      ],
      entidades: [{ _id: entidadA }],
      copropiedades: [copropiedad(copA, 'COP-A', entidadA)],
      roles: [rol(rolA, ['pqr.ver'])],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.permissions).toEqual(['facturas.ver']);
  });

  it('sin roleIds no consulta roles', async () => {
    const roles = consulta([]);
    const service = servicio({
      asignaciones: [directa({ roleIds: undefined })],
      copropiedades: [copropiedad(copA, 'COP-A')],
      roles,
    });

    await service.copropiedadesDe(cuenta.toString());

    expect(roles.find).not.toHaveBeenCalled();
  });
});

describe('AccesoService techo duro al leer', () => {
  it('una asignación de perfil personal pierde las claves de finanzas aunque estén guardadas', async () => {
    const service = servicio({
      asignaciones: [
        {
          alcance: 'copropiedad',
          copropiedadId: copA,
          perfil: 'personal',
          permisos: ['facturas.ver', 'recibos.crear'],
        },
      ],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.permissions).toEqual([]);
  });

  it('el recorte también aplica a un grant por entidad', async () => {
    const service = servicio({
      asignaciones: [
        {
          alcance: 'entidad',
          entidadId: entidadA,
          perfil: 'personal',
          permisos: ['facturas.ver'],
        },
      ],
      entidades: [{ _id: entidadA }],
      copropiedades: [copropiedad(copA, 'COP-A', entidadA)],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.permissions).toEqual([]);
  });

  it('una asignación sin perfil (legado) se trata como administrativa', async () => {
    const service = servicio({
      asignaciones: [
        {
          alcance: 'copropiedad',
          copropiedadId: copA,
          permisos: ['facturas.ver'],
        },
      ],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.permissions).toEqual(['facturas.ver']);
  });
});

describe('AccesoService perfil y nombre del rol (rótulo del encabezado)', () => {
  const rolA = oid();
  const rolB = oid();
  const directa = (extra: Fila = {}) => ({
    alcance: 'copropiedad',
    copropiedadId: copA,
    permisos: [],
    ...extra,
  });
  const rol = (
    id: Types.ObjectId,
    nombre: string,
    de = copA,
    permisos: string[] = ['pqr.ver'],
  ) => ({ _id: id, copropiedadId: de, nombre, permisos });

  it('una asignación administrativa expone el perfil y ningún rol', async () => {
    const service = servicio({
      asignaciones: [directa({ perfil: 'administrativo' })],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.perfil).toBe('administrativo');
    expect(resultado.rolNombre).toBeNull();
  });

  it('una asignación sin perfil (legado) se rotula como administrativa', async () => {
    const service = servicio({
      asignaciones: [directa()],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.perfil).toBe('administrativo');
  });

  it('el personal con rol expone el nombre de ese rol', async () => {
    const service = servicio({
      asignaciones: [directa({ perfil: 'personal', roleIds: [rolA] })],
      copropiedades: [copropiedad(copA, 'COP-A')],
      roles: [rol(rolA, 'Portero')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.perfil).toBe('personal');
    expect(resultado.rolNombre).toBe('Portero');
  });

  it('el personal sin rol queda con rolNombre null', async () => {
    const service = servicio({
      asignaciones: [directa({ perfil: 'personal', permisos: ['tareas.ver'] })],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.perfil).toBe('personal');
    expect(resultado.rolNombre).toBeNull();
  });

  it('con varios roles toma el primero que la asignación nombra', async () => {
    const service = servicio({
      asignaciones: [directa({ perfil: 'personal', roleIds: [rolB, rolA] })],
      copropiedades: [copropiedad(copA, 'COP-A')],
      roles: [rol(rolA, 'Portero'), rol(rolB, 'Jardinero')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.rolNombre).toBe('Jardinero');
  });

  it('un rol de OTRA copropiedad nunca da su nombre', async () => {
    const service = servicio({
      asignaciones: [directa({ perfil: 'personal', roleIds: [rolA] })],
      copropiedades: [copropiedad(copA, 'COP-A')],
      roles: [rol(rolA, 'Secreto de otro edificio', copB)],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.rolNombre).toBeNull();
  });

  it('el perfil y el rol corresponden a cada copropiedad, no a la primera asignación', async () => {
    const service = servicio({
      asignaciones: [
        directa({ perfil: 'personal', roleIds: [rolA] }),
        directa({ copropiedadId: copB, perfil: 'administrativo' }),
      ],
      copropiedades: [copropiedad(copA, 'COP-A'), copropiedad(copB, 'COP-B')],
      roles: [rol(rolA, 'Portero')],
    });

    const resultado = await service.copropiedadesDe(cuenta.toString());
    const de = (id: Types.ObjectId) =>
      resultado.find((c) => c.copropiedadId === id.toString());

    expect(de(copA)).toMatchObject({
      perfil: 'personal',
      rolNombre: 'Portero',
    });
    expect(de(copB)).toMatchObject({
      perfil: 'administrativo',
      rolNombre: null,
    });
  });

  it('si una vía por entidad es administrativa, el edificio se rotula administrativo', async () => {
    const service = servicio({
      asignaciones: [
        directa({ perfil: 'personal', roleIds: [rolA] }),
        {
          alcance: 'entidad',
          entidadId: entidadA,
          perfil: 'administrativo',
          permisos: ['facturas.ver'],
        },
      ],
      entidades: [{ _id: entidadA }],
      copropiedades: [copropiedad(copA, 'COP-A', entidadA)],
      roles: [rol(rolA, 'Portero')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.perfil).toBe('administrativo');
    expect(resultado.rolNombre).toBeNull();
  });

  it('un residente sin asignación en el edificio no tiene perfil ni rol', async () => {
    const service = servicio({
      asignaciones: [],
      copropiedades: [copropiedad(copA, 'COP-A')],
      terceros: [{ copropiedadId: copA }],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString());

    expect(resultado.esResidente).toBe(true);
    expect(resultado.perfil).toBeNull();
    expect(resultado.rolNombre).toBeNull();
  });

  it('el administrador de plataforma no tiene perfil ni rol', async () => {
    const service = servicio({
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const [resultado] = await service.copropiedadesDe(cuenta.toString(), true);

    expect(resultado.perfil).toBeNull();
    expect(resultado.rolNombre).toBeNull();
  });
});

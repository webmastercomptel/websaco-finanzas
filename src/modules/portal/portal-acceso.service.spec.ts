import { Types } from 'mongoose';
import { PortalAccesoService } from './portal-acceso.service';
import { claveCorreo } from '../../common/utils/email.utils';

const COP = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const TERCERO = new Types.ObjectId();
const OTRO = new Types.ObjectId();
const A1 = new Types.ObjectId();
const B2 = new Types.ObjectId();

type Fila = Record<string, unknown>;

/** Terceros model resolving `findOne(...).select().lean().exec()` to `fila`. */
const tercerosCon = (fila: Fila | null) => ({
  findOne: jest.fn((_filtro: Fila) => ({
    select: () => ({ lean: () => ({ exec: () => Promise.resolve(fila) }) }),
  })),
});

/** Inmuebles model resolving `find(...).select().sort().lean().exec()`. */
const inmueblesCon = (filas: Fila[]) => ({
  find: jest.fn((_filtro: Fila) => ({
    select: () => ({
      sort: () => ({ lean: () => ({ exec: () => Promise.resolve(filas) }) }),
    }),
  })),
});

/** Account model resolving `findById(id).select().lean().exec()`. */
const cuentasCon = (fila: Fila | null) => ({
  findById: jest.fn((_id: string) => ({
    select: () => ({ lean: () => ({ exec: () => Promise.resolve(fila) }) }),
  })),
});

const CORREO = 'persona@example.com';
const sinPrueba = { email: CORREO, estado: 'active', correoProbadoClave: null };

/** `ResidenciaService` stand-in: parties per address and revoked coproperties. */
const residenciaCon = (
  partesPorCorreo: Record<
    string,
    Array<{ id: string; copropiedadId: string }>
  > = {},
  revocadas: string[] = [],
) => ({
  tercerosPorCorreo: jest.fn((correo: string) =>
    Promise.resolve(partesPorCorreo[correo.trim().toLowerCase()] ?? []),
  ),
  revocacionesActivas: jest.fn((_clave: string, ids: readonly string[]) =>
    Promise.resolve(new Set(ids.filter((id) => revocadas.includes(id)))),
  ),
});

const servicio = (
  terceros: ReturnType<typeof tercerosCon>,
  inmuebles: ReturnType<typeof inmueblesCon>,
  cuenta: Fila | null = sinPrueba,
  residencia: ReturnType<typeof residenciaCon> = residenciaCon(),
) =>
  new PortalAccesoService(
    terceros as never,
    inmuebles as never,
    cuentasCon(cuenta) as never,
    residencia as never,
  );

describe('PortalAccesoService.unidadesDe', () => {
  it('cuenta propietaria de A-1 e inquilina de B-2: devuelve ambas con su rol', async () => {
    const service = servicio(
      tercerosCon({ _id: TERCERO }),
      inmueblesCon([
        { _id: A1, codigo: 'A-1', titularId: TERCERO, arrendatarioId: null },
        { _id: B2, codigo: 'B-2', titularId: OTRO, arrendatarioId: TERCERO },
      ]),
    );

    await expect(
      service.unidadesDe(CUENTA.toString(), COP.toString()),
    ).resolves.toEqual([
      { inmuebleId: A1.toString(), codigo: 'A-1', rol: 'propietario' },
      { inmuebleId: B2.toString(), codigo: 'B-2', rol: 'arrendatario' },
    ]);
  });

  it('una cuenta sin tercero vinculado en la copropiedad no tiene unidades', async () => {
    const inmuebles = inmueblesCon([]);
    const service = servicio(tercerosCon(null), inmuebles);

    await expect(
      service.unidadesDe(CUENTA.toString(), COP.toString()),
    ).resolves.toEqual([]);
    expect(inmuebles.find).not.toHaveBeenCalled();
  });

  it('busca el tercero y las unidades dentro de la copropiedad, solo activos', async () => {
    const terceros = tercerosCon({ _id: TERCERO });
    const inmuebles = inmueblesCon([]);

    await servicio(terceros, inmuebles).unidadesDe(
      CUENTA.toString(),
      COP.toString(),
    );

    expect(terceros.findOne).toHaveBeenCalledWith({
      copropiedadId: COP,
      accountId: CUENTA,
      estado: 'active',
    });
    expect(inmuebles.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      estado: 'active',
      $or: [
        { titularId: { $in: [TERCERO] } },
        { arrendatarioId: { $in: [TERCERO] } },
      ],
    });
  });
});

describe('PortalAccesoService.rolEn', () => {
  const service = () =>
    servicio(
      tercerosCon({ _id: TERCERO }),
      inmueblesCon([
        { _id: A1, codigo: 'A-1', titularId: TERCERO, arrendatarioId: null },
      ]),
    );

  it('devuelve el rol en una unidad propia', async () => {
    await expect(
      service().rolEn(CUENTA.toString(), COP.toString(), A1.toString()),
    ).resolves.toBe('propietario');
  });

  it('devuelve null en una unidad ajena', async () => {
    await expect(
      service().rolEn(CUENTA.toString(), COP.toString(), B2.toString()),
    ).resolves.toBeNull();
  });
});

/** Units of an ADDRESS: legacy link UNION proven address (REQ-A3, S5). */
describe('PortalAccesoService unidades por dirección probada', () => {
  const P1 = new Types.ObjectId();
  const P2 = new Types.ObjectId();
  const P_AJENO = new Types.ObjectId();
  const U101 = new Types.ObjectId();
  const U202 = new Types.ObjectId();
  const U303 = new Types.ObjectId();
  const U404 = new Types.ObjectId();
  const COP_OTRA = new Types.ObjectId();

  const probada = {
    email: CORREO,
    estado: 'active',
    correoProbadoClave: claveCorreo(CORREO),
  };
  const parte = (id: Types.ObjectId, copropiedadId = COP) => ({
    id: id.toString(),
    copropiedadId: copropiedadId.toString(),
  });
  const unidad = (
    id: Types.ObjectId,
    codigo: string,
    titularId: Types.ObjectId | null,
    arrendatarioId: Types.ObjectId | null,
  ) => ({ _id: id, codigo, titularId, arrendatarioId });
  const sinVinculo = () => tercerosCon(null);

  it('titular de 101 y arrendatario de 202 con una sola dirección: ambas unidades, cada una con su rol (S-A3.1)', async () => {
    const service = servicio(
      sinVinculo(),
      inmueblesCon([
        unidad(U101, '101', P1, null),
        unidad(U202, '202', P2, P1),
      ]),
      probada,
      residenciaCon({ [CORREO]: [parte(P1)] }),
    );

    await expect(
      service.unidadesDe(CUENTA.toString(), COP.toString()),
    ).resolves.toEqual([
      { inmuebleId: U101.toString(), codigo: '101', rol: 'propietario' },
      { inmuebleId: U202.toString(), codigo: '202', rol: 'arrendatario' },
    ]);
  });

  it('la dirección en el titular y el arrendatario de una misma unidad: una vez, propietario (S-A3.2)', async () => {
    const service = servicio(
      sinVinculo(),
      inmueblesCon([unidad(U101, '101', P1, P2)]),
      probada,
      residenciaCon({ [CORREO]: [parte(P1), parte(P2)] }),
    );

    await expect(
      service.unidadesDe(CUENTA.toString(), COP.toString()),
    ).resolves.toEqual([
      { inmuebleId: U101.toString(), codigo: '101', rol: 'propietario' },
    ]);
  });

  it('una dirección en dos registros (administrador de propiedades) que tienen 5 unidades: las 5 (S-A3.3, S-S5.1)', async () => {
    const unidades = ['1', '2', '3', '4', '5'].map((n, i) =>
      unidad(new Types.ObjectId(), n, i < 3 ? P1 : P2, null),
    );
    const service = servicio(
      sinVinculo(),
      inmueblesCon(unidades),
      probada,
      residenciaCon({ [CORREO]: [parte(P1), parte(P2)] }),
    );

    const resultado = await service.unidadesDe(
      CUENTA.toString(),
      COP.toString(),
    );

    expect(resultado.map((u) => u.codigo)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('el vínculo heredado y la dirección probada que coinciden en una unidad: una vez (S-A3.5)', async () => {
    const inmuebles = inmueblesCon([unidad(U101, '101', TERCERO, null)]);
    const service = servicio(
      tercerosCon({ _id: TERCERO }),
      inmuebles,
      probada,
      residenciaCon({ [CORREO]: [parte(TERCERO)] }),
    );

    await expect(
      service.unidadesDe(CUENTA.toString(), COP.toString()),
    ).resolves.toEqual([
      { inmuebleId: U101.toString(), codigo: '101', rol: 'propietario' },
    ]);
    // One party, asked for once.
    const filtro = inmuebles.find.mock.calls[0][0] as {
      $or: Array<Record<string, { $in: Types.ObjectId[] }>>;
    };
    expect(filtro.$or[0].titularId.$in).toHaveLength(1);
  });

  it('SEC: an address sees only units whose record carries it (S-A3.4, S-A3.7, S-S5.2)', async () => {
    // The stub returns every unit whatever the filter; the rule must drop the
    // ones whose parties are not the address's.
    const inmuebles = inmueblesCon([
      unidad(U101, '101', P1, null),
      unidad(U202, '202', P_AJENO, null),
      unidad(U303, '303', null, P_AJENO),
    ]);
    const service = servicio(
      sinVinculo(),
      inmuebles,
      probada,
      residenciaCon({
        // A record of ANOTHER coproperty carrying the same address counts for
        // nothing here.
        [CORREO]: [parte(P1), parte(P_AJENO, COP_OTRA)],
      }),
    );

    const resultado = await service.unidadesDe(
      CUENTA.toString(),
      COP.toString(),
    );

    expect(resultado.map((u) => u.codigo)).toEqual(['101']);
    const filtro = inmuebles.find.mock.calls[0][0] as {
      copropiedadId: Types.ObjectId;
      $or: Array<Record<string, { $in: Types.ObjectId[] }>>;
    };
    expect(filtro.copropiedadId).toEqual(COP);
    expect(filtro.$or[0].titularId.$in).toEqual([P1]);
  });

  it('rolEn de una unidad que no es de la dirección: null; de una que sí, su rol (S-A3.4)', async () => {
    const service = servicio(
      sinVinculo(),
      inmueblesCon([unidad(U101, '101', P1, null)]),
      probada,
      residenciaCon({ [CORREO]: [parte(P1)] }),
    );

    await expect(
      service.rolEn(CUENTA.toString(), COP.toString(), U101.toString()),
    ).resolves.toBe('propietario');
    await expect(
      service.rolEn(CUENTA.toString(), COP.toString(), U404.toString()),
    ).resolves.toBeNull();
  });

  it('dos direcciones de una misma persona son dos cuentas: cada una ve solo las unidades de los registros que la llevan (S-S5.4)', async () => {
    const residencia = residenciaCon({
      'a@example.com': [parte(P1)],
      'b@example.com': [parte(P1), parte(P2)],
    });
    // The query filter decides which units come back; the stub answers per
    // account by looking at the parties it was asked about.
    const inmueblesPorFiltro = (filtro: {
      $or: Array<Record<string, { $in: Types.ObjectId[] }>>;
    }) => {
      const pedidos = filtro.$or[0].titularId.$in.map(String);
      return [
        unidad(U101, '101', P1, null),
        unidad(U202, '202', P2, null),
      ].filter((u) => pedidos.includes(String(u.titularId)));
    };
    const inmuebles = {
      find: jest.fn((filtro: never) => ({
        select: () => ({
          sort: () => ({
            lean: () => ({
              exec: () => Promise.resolve(inmueblesPorFiltro(filtro)),
            }),
          }),
        }),
      })),
    };
    const cuentaDe = (email: string) => ({
      email,
      estado: 'active',
      correoProbadoClave: claveCorreo(email),
    });

    const deA = await servicio(
      sinVinculo(),
      inmuebles,
      cuentaDe('a@example.com'),
      residencia,
    ).unidadesDe(CUENTA.toString(), COP.toString());
    const deB = await servicio(
      sinVinculo(),
      inmuebles,
      cuentaDe('b@example.com'),
      residencia,
    ).unidadesDe(CUENTA.toString(), COP.toString());

    expect(deA.map((u) => u.codigo)).toEqual(['101']);
    expect(deB.map((u) => u.codigo)).toEqual(['101', '202']);
  });

  it('SEC: no proof, a stale proof or an inactive account never reaches the records (S-A1.3, S-A1.11)', async () => {
    for (const cuenta of [
      sinPrueba,
      { ...probada, correoProbadoClave: claveCorreo('anterior@example.com') },
      { ...probada, estado: 'inactive' },
    ]) {
      const residencia = residenciaCon({ [CORREO]: [parte(P1)] });
      const inmuebles = inmueblesCon([unidad(U101, '101', P1, null)]);
      const service = servicio(sinVinculo(), inmuebles, cuenta, residencia);

      await expect(
        service.unidadesDe(CUENTA.toString(), COP.toString()),
      ).resolves.toEqual([]);
      expect(residencia.tercerosPorCorreo).not.toHaveBeenCalled();
      expect(inmuebles.find).not.toHaveBeenCalled();
    }
  });

  it('una revocación de C quita C, también al vínculo heredado, sin tocar las demás copropiedades (S-V4.6)', async () => {
    const inmuebles = inmueblesCon([unidad(U101, '101', TERCERO, null)]);
    const residencia = residenciaCon({}, [COP.toString()]);
    const service = servicio(
      tercerosCon({ _id: TERCERO }),
      inmuebles,
      sinPrueba,
      residencia,
    );

    await expect(
      service.unidadesDe(CUENTA.toString(), COP.toString()),
    ).resolves.toEqual([]);
    expect(residencia.revocacionesActivas).toHaveBeenCalledWith(
      claveCorreo(CORREO),
      [COP.toString()],
    );
    expect(inmuebles.find).not.toHaveBeenCalled();

    // Revoked somewhere else: this coproperty is untouched.
    const otra = servicio(
      tercerosCon({ _id: TERCERO }),
      inmueblesCon([unidad(U101, '101', TERCERO, null)]),
      sinPrueba,
      residenciaCon({}, [COP_OTRA.toString()]),
    );
    await expect(
      otra.unidadesDe(CUENTA.toString(), COP.toString()),
    ).resolves.toHaveLength(1);
  });

  it('sin vínculo ni prueba no cuesta consultas de revocación', async () => {
    const residencia = residenciaCon();
    const service = servicio(
      sinVinculo(),
      inmueblesCon([]),
      sinPrueba,
      residencia,
    );

    await service.unidadesDe(CUENTA.toString(), COP.toString());

    expect(residencia.revocacionesActivas).not.toHaveBeenCalled();
  });

  it('si la cuenta no se encuentra, el vínculo heredado sigue funcionando como antes', async () => {
    const service = servicio(
      tercerosCon({ _id: TERCERO }),
      inmueblesCon([unidad(U101, '101', TERCERO, null)]),
      null,
    );

    await expect(
      service.unidadesDe(CUENTA.toString(), COP.toString()),
    ).resolves.toHaveLength(1);
  });
});

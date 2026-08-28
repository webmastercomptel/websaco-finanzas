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
}) =>
  new AccesoService(
    consulta(opts.asignaciones ?? []) as never,
    consulta(opts.copropiedades ?? []) as never,
    consulta(opts.entidades ?? []) as never,
  );

const copropiedad = (
  id: Types.ObjectId,
  code: string,
  entidad?: Types.ObjectId,
) => ({
  _id: id,
  code,
  name: `Edificio ${code}`,
  managingEntityId: entidad ?? null,
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
          scope: 'copropiedad',
          coPropertyId: copA,
          permissions: ['facturas.ver'],
        },
      ],
      copropiedades: [copropiedad(copA, 'COP-A')],
    });

    const resultado = await service.copropiedadesDe(cuenta.toString());

    expect(resultado).toHaveLength(1);
    expect(resultado[0]).toMatchObject({
      coPropertyId: copA.toString(),
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
          scope: 'entidad',
          entidadId: entidadA,
          permissions: ['facturas.ver', 'recibos.crear'],
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
    // La consulta de entidades filtra por status activo, así que no vuelve
    // ninguna: el acceso por esa vía desaparece.
    const service = servicio({
      asignaciones: [
        {
          scope: 'entidad',
          entidadId: entidadA,
          permissions: ['facturas.ver'],
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
        { scope: 'copropiedad', coPropertyId: null, permissions: ['x.y'] },
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
        { scope: 'copropiedad', coPropertyId: copC, permissions: ['x.y'] },
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
          scope: 'copropiedad',
          coPropertyId: copA,
          permissions: ['facturas.ver'],
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
        { scope: 'copropiedad', coPropertyId: copA, permissions: [] },
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

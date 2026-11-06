import { Types } from 'mongoose';
import { PortalAccesoService } from './portal-acceso.service';

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

const servicio = (
  terceros: ReturnType<typeof tercerosCon>,
  inmuebles: ReturnType<typeof inmueblesCon>,
) => new PortalAccesoService(terceros as never, inmuebles as never);

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
      $or: [{ titularId: TERCERO }, { arrendatarioId: TERCERO }],
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

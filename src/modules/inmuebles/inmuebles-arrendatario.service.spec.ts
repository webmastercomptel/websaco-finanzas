import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InmueblesService } from './inmuebles.service';
import { toInmueble } from './inmuebles.mapper';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';
import type { InmuebleDocument } from '../../database/schemas/copropiedades/inmueble.schema';

const COP = new Types.ObjectId();
const TITULAR = new Types.ObjectId();
const ARRENDATARIO = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const documento = () => ({
  _id: { toString: () => 'inm-1' },
  codigo: '301',
  titularId: null,
  arrendatarioId: null,
  tipoTitular: 'propietario',
  estadoCartera: 'vigente',
  estado: 'active',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

/** Inmuebles model that records writes and serves a stored unit. */
const inmueblesCon = (guardado: Record<string, unknown> = {}) => {
  const escrituras: Record<string, unknown>[] = [];
  return {
    escrituras,
    exists: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve(documento());
    }),
    findOneAndUpdate: jest.fn(
      (_filtro: Filtro, update: Record<string, unknown>) => {
        escrituras.push((update as { $set: Record<string, unknown> }).$set);
        return { exec: () => Promise.resolve(documento()) };
      },
    ),
    findOne: jest.fn(() => ({
      populate: () => ({ exec: () => Promise.resolve(documento()) }),
      select: () => ({
        lean: () => ({
          exec: () => Promise.resolve({ codigo: '301', ...guardado }),
        }),
      }),
    })),
  };
};

/** Terceros model: `existe` says whether the id belongs to the active coproperty. */
const tercerosCon = (existe: boolean) => ({
  exists: jest.fn((_filtro: Filtro) => ({
    exec: () => Promise.resolve(existe ? { _id: 'x' } : null),
  })),
});

const tenant = {
  resolveCoPropertyId: () => COP,
} as unknown as TenantContextService;

const servicio = (
  inmuebles: ReturnType<typeof inmueblesCon>,
  terceros: ReturnType<typeof tercerosCon>,
) =>
  new InmueblesService(
    inmuebles as never,
    {} as never,
    terceros as never,
    tenant,
    {} as never,
    {} as never,
  );

describe('Inmueble.arrendatarioId — escritura', () => {
  it('create: escribe el arrendatario cuando es un tercero de la copropiedad', async () => {
    const inmuebles = inmueblesCon();
    const terceros = tercerosCon(true);

    await servicio(inmuebles, terceros).create({
      codigo: '301',
      titularId: TITULAR.toString(),
      arrendatarioId: ARRENDATARIO.toString(),
    });

    expect(terceros.exists).toHaveBeenCalledWith({
      _id: ARRENDATARIO.toString(),
      copropiedadId: COP,
    });
    expect(inmuebles.escrituras[0]).toMatchObject({
      arrendatarioId: ARRENDATARIO.toString(),
    });
  });

  it('create: rechaza con 400 un arrendatario que no es de esta copropiedad, sin escribir', async () => {
    const inmuebles = inmueblesCon();

    await expect(
      servicio(inmuebles, tercerosCon(false)).create({
        codigo: '301',
        arrendatarioId: ARRENDATARIO.toString(),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(inmuebles.create).not.toHaveBeenCalled();
  });

  it('create: rechaza con 400 que el arrendatario sea el propietario', async () => {
    const inmuebles = inmueblesCon();

    await expect(
      servicio(inmuebles, tercerosCon(true)).create({
        codigo: '301',
        titularId: TITULAR.toString(),
        arrendatarioId: TITULAR.toString(),
      }),
    ).rejects.toThrow('El arrendatario no puede ser el propietario');
    expect(inmuebles.create).not.toHaveBeenCalled();
  });

  it('update: quitar el arrendatario con null lo escribe sin consultar terceros', async () => {
    const inmuebles = inmueblesCon({ arrendatarioId: ARRENDATARIO });
    const terceros = tercerosCon(true);

    await servicio(inmuebles, terceros).update('inm-1', {
      arrendatarioId: null,
    });

    expect(terceros.exists).not.toHaveBeenCalled();
    expect(inmuebles.escrituras[0]).toEqual({ arrendatarioId: null });
  });

  it('update: rechaza con 400 un nuevo propietario igual al arrendatario guardado', async () => {
    const inmuebles = inmueblesCon({ arrendatarioId: ARRENDATARIO });

    await expect(
      servicio(inmuebles, tercerosCon(true)).update('inm-1', {
        titularId: ARRENDATARIO.toString(),
      }),
    ).rejects.toThrow('El arrendatario no puede ser el propietario');
    expect(inmuebles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('update: un patch sin arrendatario no lo toca ni consulta terceros', async () => {
    const inmuebles = inmueblesCon({ arrendatarioId: ARRENDATARIO });
    const terceros = tercerosCon(true);

    await servicio(inmuebles, terceros).update('inm-1', { bloque: 'A' });

    expect(terceros.exists).not.toHaveBeenCalled();
    expect(inmuebles.escrituras[0]).toEqual({ bloque: 'A' });
  });
});

describe('toInmueble — arrendatario', () => {
  const base = {
    ...documento(),
    _id: new Types.ObjectId(),
  } as unknown as InmuebleDocument;

  it('expone el arrendatario cuando viene poblado', () => {
    const contrato = toInmueble({
      ...base,
      arrendatarioId: {
        _id: ARRENDATARIO,
        nombre: 'Ana Pérez',
        numeroIdentificacion: '123',
      },
    } as unknown as InmuebleDocument);

    expect(contrato.arrendatario).toMatchObject({ nombre: 'Ana Pérez' });
  });

  it('es null cuando no hay arrendatario o no se pobló', () => {
    expect(toInmueble(base).arrendatario).toBeNull();
    expect(
      toInmueble({
        ...base,
        arrendatarioId: ARRENDATARIO,
      } as unknown as InmuebleDocument).arrendatario,
    ).toBeNull();
  });
});

describe('Inmueble.titularId — mismo tenant (hallazgo 10)', () => {
  /** Only the ids in `propios` are Terceros of the active coproperty. */
  const tercerosDe = (...propios: Types.ObjectId[]) => ({
    exists: jest.fn((filtro: Filtro) => ({
      exec: () =>
        Promise.resolve(
          String(filtro.copropiedadId) === String(COP) &&
            propios.some((p) => String(p) === String(filtro._id))
            ? { _id: String(filtro._id) }
            : null,
        ),
    })),
  });

  it('create: rechaza con 400 un titular de OTRA copropiedad, sin escribir', async () => {
    const inmuebles = inmueblesCon();
    const terceros = tercerosDe();

    await expect(
      servicio(inmuebles, terceros).create({
        codigo: '301',
        titularId: TITULAR.toString(),
      }),
    ).rejects.toThrow('El propietario no existe en esta copropiedad');
    expect(terceros.exists).toHaveBeenCalledWith({
      _id: TITULAR.toString(),
      copropiedadId: COP,
    });
    expect(inmuebles.create).not.toHaveBeenCalled();
  });

  it('update: rechaza con 400 cambiar el titular a uno de otra copropiedad', async () => {
    const inmuebles = inmueblesCon();

    await expect(
      servicio(inmuebles, tercerosDe()).update('inm-1', {
        titularId: TITULAR.toString(),
      }),
    ).rejects.toThrow(BadRequestException);
    expect(inmuebles.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('create: un titular propio pasa', async () => {
    const inmuebles = inmueblesCon();

    await servicio(inmuebles, tercerosDe(TITULAR)).create({
      codigo: '301',
      titularId: TITULAR.toString(),
    });

    expect(inmuebles.create).toHaveBeenCalled();
  });

  it('la lectura solo puebla partes de la copropiedad activa (un id ajeno guardado no se lee)', async () => {
    const populate = jest.fn(() => ({
      exec: () => Promise.resolve(documento()),
    }));
    const inmuebles = {
      ...inmueblesCon(),
      findOne: jest.fn(() => ({ populate })),
    };

    await servicio(inmuebles as never, tercerosDe()).findOne('inm-1');

    expect(populate).toHaveBeenCalledWith([
      expect.objectContaining({
        path: 'titularId',
        match: { copropiedadId: COP },
      }),
      expect.objectContaining({
        path: 'arrendatarioId',
        match: { copropiedadId: COP },
      }),
    ]);
  });
});

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { InmueblesService } from './inmuebles.service';
import type { TenantContextService } from '../../common/tenant/tenant-context.service';

const COP = new Types.ObjectId();

type Filtro = Record<string, unknown>;

const documento = () => ({
  _id: { toString: () => 'inm-1' },
  codigo: '301',
  bloque: null,
  zona: null,
  uso: null,
  area: null,
  coeficiente: null,
  titularId: null,
  tipoTitular: 'propietario',
  resideEnElInmueble: true,
  estadoCartera: 'vigente',
  estado: 'active',
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

/** Records what was written, and whether a duplicate was reported. */
const modeloCon = (
  opts: { duplicado?: boolean; sinInmueble?: boolean } = {},
) => {
  const escrituras: Record<string, unknown>[] = [];
  const filtros: Filtro[] = [];
  const lecturas: Filtro[] = [];

  return {
    escrituras,
    filtros,
    lecturas,
    exists: jest.fn((filtro: Filtro) => {
      filtros.push(filtro);
      return {
        exec: () => Promise.resolve(opts.duplicado ? { _id: 'x' } : null),
      };
    }),
    create: jest.fn((doc: Record<string, unknown>) => {
      escrituras.push(doc);
      return Promise.resolve(documento());
    }),
    findOneAndUpdate: jest.fn(
      (filtro: Filtro, update: Record<string, unknown>) => {
        filtros.push(filtro);
        escrituras.push((update as { $set: Record<string, unknown> }).$set);
        return { exec: () => Promise.resolve(documento()) };
      },
    ),
    findOne: jest.fn((filtro: Filtro) => {
      lecturas.push(filtro);
      return {
        populate: () => ({ exec: () => Promise.resolve(documento()) }),
        // The code check in `update` reads only the stored code, tenant-scoped.
        select: () => ({
          lean: () => ({
            exec: () =>
              Promise.resolve(opts.sinInmueble ? null : { codigo: '301' }),
          }),
        }),
      };
    }),
  };
};

const nuevoServicio = (modelo: ReturnType<typeof modeloCon>) =>
  new InmueblesService(
    modelo as never,
    {} as never,
    {} as never,
    tenant,
    {} as never,
    {} as never,
    {} as never,
  );

const tenant = {
  resolveCoPropertyId: () => COP,
} as unknown as TenantContextService;

const tenantSinCopropiedad = {
  resolveCoPropertyId: () => {
    throw new ForbiddenException('sin copropiedad activa');
  },
} as unknown as TenantContextService;

describe('InmueblesService.create', () => {
  it('escribe la copropiedad del contexto, no una del cuerpo', async () => {
    // Aceptar el tenant del body dejaría crear un inmueble dentro del edificio
    // de otro cliente.
    const modelo = modeloCon();
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenant,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.create({ codigo: '401' });

    expect(modelo.escrituras[0]).toMatchObject({
      codigo: '401',
      copropiedadId: COP,
    });
  });

  it('rechaza un código repetido con un mensaje entendible', async () => {
    // Sin este chequeo el índice único devuelve un error del driver nombrando
    // un índice que la persona nunca vio.
    const modelo = modeloCon({ duplicado: true });
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenant,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.create({ codigo: '301' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('busca el duplicado solo dentro de la copropiedad activa', async () => {
    // "301" existe en todos los edificios; el choque es dentro de uno.
    const modelo = modeloCon();
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenant,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.create({ codigo: '301' });

    // Case/whitespace-insensitive on purpose — see
    // `InmueblesService.filtroCodigoDuplicado`.
    expect(modelo.filtros[0]).toEqual({
      copropiedadId: COP,
      codigo: { $regex: '^301$', $options: 'i' },
    });
  });

  it('falla cerrado sin copropiedad activa, antes de escribir', async () => {
    const modelo = modeloCon();
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenantSinCopropiedad,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.create({ codigo: '401' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(modelo.create).not.toHaveBeenCalled();
  });
});

describe('InmueblesService.update', () => {
  it('incluye la copropiedad en el match, no la verifica después', async () => {
    // Es lo que impide editar un inmueble de otro edificio conociendo su id.
    const modelo = modeloCon();
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenant,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.update('inm-1', { zona: 'Norte' });

    expect(modelo.filtros[0]).toEqual({ _id: 'inm-1', copropiedadId: COP });
  });

  it('solo escribe los campos que vinieron en el patch', async () => {
    // Esparcir el DTO entero escribiría `undefined` sobre campos que nadie
    // quiso borrar — la forma clásica en que un patch borra datos en silencio.
    const modelo = modeloCon();
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenant,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.update('inm-1', { zona: 'Norte' });

    expect(modelo.escrituras[0]).toEqual({ zona: 'Norte' });
  });

  it('traduce estado "inactivo"/"activo" a status "inactive"/"active"', async () => {
    const modelo = modeloCon();
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenant,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.update('inm-1', { estado: 'inactivo' });
    expect(modelo.escrituras[0]).toEqual({ estado: 'inactive' });

    await service.update('inm-1', { estado: 'activo' });
    expect(modelo.escrituras[1]).toEqual({ estado: 'active' });
  });

  it('no toca status cuando el patch no trae estado', async () => {
    const modelo = modeloCon();
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenant,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.update('inm-1', { zona: 'Norte' });

    expect(modelo.escrituras[0]).not.toHaveProperty('estado');
  });

  // The two tests that used to live here asserted the duplicate check inside
  // `update` ("no choca consigo mismo" / "rechaza un código que ya existe con
  // otra capitalización"). The code is immutable now, so that check is gone.
  it('ignora el código reenviado igual al guardado y no lo escribe', async () => {
    // El formulario reenvía el código en cada edición; no es un cambio.
    const modelo = modeloCon();
    const service = nuevoServicio(modelo);

    await service.update('inm-1', { codigo: '301', zona: 'Norte' });

    expect(modelo.escrituras[0]).toEqual({ zona: 'Norte' });
    expect(modelo.escrituras[0]).not.toHaveProperty('codigo');
    expect(modelo.exists).not.toHaveBeenCalled();
  });

  it('ignora el código reenviado con espacios alrededor', async () => {
    const modelo = modeloCon();
    const service = nuevoServicio(modelo);

    await service.update('inm-1', { codigo: '  301 ', zona: 'Norte' });

    expect(modelo.escrituras[0]).toEqual({ zona: 'Norte' });
  });

  it('rechaza con 400 un código distinto al guardado, sin escribir', async () => {
    const modelo = modeloCon();
    const service = nuevoServicio(modelo);

    const intento = service.update('inm-1', { codigo: '302' });

    await expect(intento).rejects.toBeInstanceOf(BadRequestException);
    await expect(intento).rejects.toThrow(
      'El código de un inmueble no se puede modificar después de crearlo.',
    );
    expect(modelo.findOneAndUpdate).not.toHaveBeenCalled();
    expect(modelo.exists).not.toHaveBeenCalled();
  });

  it('rechaza con 400 un cambio solo de mayúsculas del código', async () => {
    const modelo = modeloCon();
    modelo.findOne = jest.fn(() => ({
      select: () => ({
        lean: () => ({
          exec: () => Promise.resolve({ codigo: 'Torre A-301' }),
        }),
      }),
    })) as never;
    const service = nuevoServicio(modelo);

    await expect(
      service.update('inm-1', { codigo: 'torre a-301' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(modelo.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('lee el código guardado dentro de la copropiedad activa', async () => {
    const modelo = modeloCon();
    const service = nuevoServicio(modelo);

    await service.update('inm-1', { codigo: '301' });

    expect(modelo.lecturas[0]).toEqual({ _id: 'inm-1', copropiedadId: COP });
  });

  it('acepta un patch sin código y sigue permitiendo editar otros campos', async () => {
    const modelo = modeloCon();
    const service = nuevoServicio(modelo);

    await service.update('inm-1', { zona: 'Sur', bloque: 'B' });

    expect(modelo.escrituras[0]).toEqual({ zona: 'Sur', bloque: 'B' });
  });

  it('responde "no existe" (404) si el inmueble es de otra copropiedad, aunque traiga otro código', async () => {
    // Sin esto, un código distinto devolvería 400 y confirmaría que el id existe.
    const modelo = modeloCon({ sinInmueble: true });
    const service = nuevoServicio(modelo);

    await expect(
      service.update('inm-ajeno', { codigo: '999' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(modelo.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('responde "no existe" para un inmueble de otra copropiedad', async () => {
    const modelo = modeloCon();
    modelo.findOneAndUpdate = jest.fn(() => ({
      exec: () => Promise.resolve(null),
    })) as never;
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      {} as never,
      tenant,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.update('inm-ajeno', { zona: 'Norte' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

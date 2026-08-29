import {
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
  code: '301',
  block: null,
  zone: null,
  usage: null,
  area: null,
  participationFactor: null,
  holderId: null,
  holderKind: 'propietario',
  holderResides: true,
  collectionStatus: 'al_dia',
  status: 'active',
});

/** Records what was written, and whether a duplicate was reported. */
const modeloCon = (opts: { duplicado?: boolean } = {}) => {
  const escrituras: Record<string, unknown>[] = [];
  const filtros: Filtro[] = [];

  return {
    escrituras,
    filtros,
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
    findOne: jest.fn(() => ({
      populate: () => ({ exec: () => Promise.resolve(documento()) }),
    })),
  };
};

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
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await service.create({ codigo: '401' });

    expect(modelo.escrituras[0]).toMatchObject({
      code: '401',
      coPropertyId: COP,
    });
  });

  it('rechaza un código repetido con un mensaje entendible', async () => {
    // Sin este chequeo el índice único devuelve un error del driver nombrando
    // un índice que la persona nunca vio.
    const modelo = modeloCon({ duplicado: true });
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await expect(service.create({ codigo: '301' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('busca el duplicado solo dentro de la copropiedad activa', async () => {
    // "301" existe en todos los edificios; el choque es dentro de uno.
    const modelo = modeloCon();
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await service.create({ codigo: '301' });

    expect(modelo.filtros[0]).toEqual({ coPropertyId: COP, code: '301' });
  });

  it('falla cerrado sin copropiedad activa, antes de escribir', async () => {
    const modelo = modeloCon();
    const service = new InmueblesService(
      modelo as never,
      {} as never,
      tenantSinCopropiedad,
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
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await service.update('inm-1', { zona: 'Norte' });

    expect(modelo.filtros[0]).toEqual({ _id: 'inm-1', coPropertyId: COP });
  });

  it('solo escribe los campos que vinieron en el patch', async () => {
    // Esparcir el DTO entero escribiría `undefined` sobre campos que nadie
    // quiso borrar — la forma clásica en que un patch borra datos en silencio.
    const modelo = modeloCon();
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await service.update('inm-1', { zona: 'Norte' });

    expect(modelo.escrituras[0]).toEqual({ zone: 'Norte' });
  });

  it('traduce estado activo/inactivo al del documento', async () => {
    const modelo = modeloCon();
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await service.update('inm-1', { estado: 'inactivo' });

    expect(modelo.escrituras[0]).toEqual({ status: 'inactive' });
  });

  it('desactivar es una edición, no un borrado', async () => {
    // No existe endpoint de borrado y no debe existir: quitar la fila dejaría
    // huérfano cada documento emitido contra ella.
    const modelo = modeloCon();
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await service.update('inm-1', { estado: 'inactivo' });

    expect(modelo.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(
      (modelo as unknown as Record<string, unknown>).deleteOne,
    ).toBeUndefined();
  });

  it('no choca consigo mismo al guardar sin cambiar el código', async () => {
    const modelo = modeloCon();
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await service.update('inm-1', { codigo: '301' });

    expect(modelo.filtros[0]).toEqual({
      coPropertyId: COP,
      code: '301',
      _id: { $ne: 'inm-1' },
    });
  });

  it('responde "no existe" para un inmueble de otra copropiedad', async () => {
    const modelo = modeloCon();
    modelo.findOneAndUpdate = jest.fn(() => ({
      exec: () => Promise.resolve(null),
    })) as never;
    const service = new InmueblesService(modelo as never, {} as never, tenant);

    await expect(
      service.update('inm-ajeno', { zona: 'Norte' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

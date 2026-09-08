import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { InmueblesEliminacionService } from './inmuebles-eliminacion.service';

const COP = new Types.ObjectId();

const tenant = () => ({ resolveCoPropertyId: () => COP }) as never;

const modeloInmuebles = (existe: boolean) => ({
  exists: jest.fn(() => ({
    exec: () => Promise.resolve(existe ? { _id: 'inm-1' } : null),
  })),
  deleteOne: jest.fn(() => ({
    exec: () => Promise.resolve({ deletedCount: 1 }),
  })),
});

const modeloFacturas = (facturado: boolean) => ({
  exists: jest.fn(() => ({
    exec: () => Promise.resolve(facturado ? { _id: 'fac-1' } : null),
  })),
});

const modeloValoresRecurrentes = () => ({
  deleteMany: jest.fn(() => ({
    exec: () => Promise.resolve({ deletedCount: 2 }),
  })),
});

describe('InmueblesEliminacionService.eliminar', () => {
  it('responde "no existe" cuando el inmueble no es de esta copropiedad', async () => {
    const inmuebles = modeloInmuebles(false);
    const service = new InmueblesEliminacionService(
      inmuebles as never,
      modeloFacturas(false) as never,
      modeloValoresRecurrentes() as never,
      tenant(),
    );

    await expect(service.eliminar('inm-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(inmuebles.deleteOne).not.toHaveBeenCalled();
  });

  it('rechaza eliminar un inmueble que ya tiene facturas emitidas', async () => {
    const inmuebles = modeloInmuebles(true);
    const service = new InmueblesEliminacionService(
      inmuebles as never,
      modeloFacturas(true) as never,
      modeloValoresRecurrentes() as never,
      tenant(),
    );

    await expect(service.eliminar('inm-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(inmuebles.deleteOne).not.toHaveBeenCalled();
  });

  it('elimina el inmueble y sus valores recurrentes cuando nunca fue facturado', async () => {
    const inmuebles = modeloInmuebles(true);
    const valoresRecurrentes = modeloValoresRecurrentes();
    const service = new InmueblesEliminacionService(
      inmuebles as never,
      modeloFacturas(false) as never,
      valoresRecurrentes as never,
      tenant(),
    );

    await service.eliminar('inm-1');

    expect(valoresRecurrentes.deleteMany).toHaveBeenCalledTimes(1);
    expect(inmuebles.deleteOne).toHaveBeenCalledTimes(1);
  });
});

/** A roster of units, each optionally already billed. */
const modeloInmueblesRoster = (unidades: { id: string; codigo: string }[]) => ({
  find: jest.fn(() => ({
    select: jest.fn(() => ({
      exec: () =>
        Promise.resolve(unidades.map((u) => ({ _id: u.id, code: u.codigo }))),
    })),
  })),
  deleteMany: jest.fn(() => ({
    exec: () => Promise.resolve({ deletedCount: unidades.length }),
  })),
});

const modeloFacturasDistinct = (idsFacturados: string[] = []) => ({
  distinct: jest.fn(() => Promise.resolve(idsFacturados)),
});

const modeloValoresRecurrentesDeleteMany = () => ({
  deleteMany: jest.fn(() => ({
    exec: () => Promise.resolve({ deletedCount: 0 }),
  })),
});

describe('InmueblesEliminacionService.eliminarTodosEliminables', () => {
  it('no hace ninguna consulta más cuando la copropiedad no tiene inmuebles', async () => {
    const inmuebles = modeloInmueblesRoster([]);
    const facturas = modeloFacturasDistinct();
    const service = new InmueblesEliminacionService(
      inmuebles as never,
      facturas as never,
      modeloValoresRecurrentesDeleteMany() as never,
      tenant(),
    );

    const resultado = await service.eliminarTodosEliminables();

    expect(resultado).toEqual({ eliminados: 0, bloqueados: [] });
    expect(facturas.distinct).not.toHaveBeenCalled();
    expect(inmuebles.deleteMany).not.toHaveBeenCalled();
  });

  it('borra los inmuebles sin factura y deja intactos los que sí tienen', async () => {
    const inmuebles = modeloInmueblesRoster([
      { id: 'inm-1', codigo: '101' },
      { id: 'inm-2', codigo: '102' },
      { id: 'inm-3', codigo: '103' },
    ]);
    const facturas = modeloFacturasDistinct(['inm-2']);
    const valoresRecurrentes = modeloValoresRecurrentesDeleteMany();
    const service = new InmueblesEliminacionService(
      inmuebles as never,
      facturas as never,
      valoresRecurrentes as never,
      tenant(),
    );

    const resultado = await service.eliminarTodosEliminables();

    expect(resultado).toEqual({ eliminados: 2, bloqueados: ['102'] });
    expect(inmuebles.deleteMany).toHaveBeenCalledWith({
      _id: { $in: ['inm-1', 'inm-3'] },
      coPropertyId: COP,
    });
    expect(valoresRecurrentes.deleteMany).toHaveBeenCalledWith({
      coPropertyId: COP,
      inmuebleId: { $in: ['inm-1', 'inm-3'] },
    });
  });
});

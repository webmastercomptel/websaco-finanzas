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

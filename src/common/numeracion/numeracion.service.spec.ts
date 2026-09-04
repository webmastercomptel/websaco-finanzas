import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { NumeracionService } from './numeracion.service';

const COP = new Types.ObjectId().toString();

type Filtro = Record<string, unknown>;

/**
 * Stands in for the resolution collection, incrementing in one step the way
 * Mongo's findOneAndUpdate does — so the ceiling condition is exercised as part
 * of the same operation, not as a check the test performs on its behalf.
 */
const resolucionesCon = (fila: Record<string, unknown> | null) => {
  const estado = fila ? { ...fila } : null;

  return {
    // Declares both parameters even though only the filter is read: the test
    // below asserts on the update document, and jest infers the call tuple
    // from this signature.
    findOneAndUpdate: jest.fn((filtro: Filtro, _update?: Filtro) => ({
      exec: () => {
        if (!estado) return Promise.resolve(null);
        if (filtro.status === 'active' && estado.status !== 'active') {
          return Promise.resolve(null);
        }
        // The $expr ceiling: nextNumber must still be inside the range.
        if ((estado.nextNumber as number) > (estado.rangeTo as number)) {
          return Promise.resolve(null);
        }
        const previa = { ...estado };
        estado.nextNumber = (estado.nextNumber as number) + 1;
        return Promise.resolve(previa);
      },
    })),
    // Honours the status filter, like the real collection: the service asks
    // specifically for an ACTIVE resolution when working out which of the two
    // failures happened, and a stub that ignores that would report "exhausted"
    // for a building whose resolution is merely switched off.
    findOne: jest.fn((filtro: Filtro) => ({
      lean: () => ({
        exec: () =>
          Promise.resolve(
            estado && filtro.status === 'active' && estado.status !== 'active'
              ? null
              : estado,
          ),
      }),
    })),
  };
};

const consecutivosCon = (fila: Record<string, unknown> | null) => {
  const estado = fila ? { ...fila } : null;

  return {
    findOneAndUpdate: jest.fn(
      (_filtro?: unknown, _update?: unknown, _opciones?: unknown) => ({
        exec: () => {
          // No upsert: a real findOneAndUpdate matches nothing and returns
          // null when the row doesn't exist — the service turns that into
          // NotFoundException.
          if (!estado) return Promise.resolve(null);
          estado.nextNumber = (estado.nextNumber as number) + 1;
          return Promise.resolve({ ...estado });
        },
      }),
    ),
  };
};

const consecutivosLoteCon = (fila: Record<string, unknown> | null) => {
  let estado = fila ? { ...fila } : null;

  return {
    findOneAndUpdate: jest.fn(() => ({
      exec: () => {
        if (!estado) {
          // On upsert, $inc creates nextNumber at 1, new: true returns post-image
          estado = { nextNumber: 1 };
          return Promise.resolve(estado);
        }
        // On normal update, increment first, then return post-image
        estado.nextNumber = (estado.nextNumber as number) + 1;
        return Promise.resolve({ ...estado });
      },
    })),
  };
};

const servicio = (
  resolucion: Record<string, unknown> | null,
  consecutivo: Record<string, unknown> | null = null,
  consecutivoLote: Record<string, unknown> | null = null,
) =>
  new NumeracionService(
    resolucionesCon(resolucion) as never,
    consecutivosCon(consecutivo) as never,
    consecutivosLoteCon(consecutivoLote) as never,
  );

const resolucionActiva = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  resolutionNumber: '18764000001',
  prefix: 'CONJ-2026',
  rangeFrom: 1,
  rangeTo: 5000,
  nextNumber: 1,
  status: 'active',
  ...over,
});

describe('NumeracionService.siguienteFactura', () => {
  it('entrega el número con su prefijo y el id de la resolución', async () => {
    const resolucion = resolucionActiva({ nextNumber: 1041 });
    const service = servicio(resolucion);

    await expect(service.siguienteFactura(COP)).resolves.toEqual({
      prefijo: 'CONJ-2026',
      numero: 1041,
      completo: 'CONJ-2026-1041',
      resolucionId: resolucion._id,
    });
  });

  it('avanza uno por documento y nunca repite', async () => {
    // El corazón del asunto: dos facturas no pueden llevar el mismo número.
    const service = servicio(resolucionActiva({ nextNumber: 1 }));

    const emitidos = [
      await service.siguienteFactura(COP),
      await service.siguienteFactura(COP),
      await service.siguienteFactura(COP),
    ].map((n) => n.numero);

    expect(emitidos).toEqual([1, 2, 3]);
    expect(new Set(emitidos).size).toBe(3);
  });

  it('entrega el último número del rango', async () => {
    const service = servicio(resolucionActiva({ nextNumber: 5000 }));

    await expect(service.siguienteFactura(COP)).resolves.toMatchObject({
      numero: 5000,
    });
  });

  it('se niega cuando el rango se agotó, diciendo hasta dónde llegaba', async () => {
    const service = servicio(resolucionActiva({ nextNumber: 5001 }));

    await expect(service.siguienteFactura(COP)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.siguienteFactura(COP)).rejects.toThrow('5000');
  });

  it('distingue "no hay resolución" de "se agotó"', async () => {
    // Son llamadas distintas: una es cargar un dato, la otra es hablar con el
    // contador. Un mismo error para las dos manda a buscar al lugar equivocado.
    const service = servicio(null);

    await expect(service.siguienteFactura(COP)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('ignora una resolución inactiva', async () => {
    const service = servicio(resolucionActiva({ status: 'inactive' }));

    await expect(service.siguienteFactura(COP)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('funciona sin prefijo', async () => {
    const service = servicio(resolucionActiva({ prefix: '', nextNumber: 7 }));

    await expect(service.siguienteFactura(COP)).resolves.toMatchObject({
      completo: '7',
    });
  });

  it('reserva en una sola operación de base de datos', async () => {
    // Leer y después escribir entrega el mismo número dos veces bajo carga.
    // Que sea un solo findOneAndUpdate es la garantía, así que se verifica.
    const resoluciones = resolucionesCon(resolucionActiva());
    const service = new NumeracionService(
      resoluciones as never,
      consecutivosCon(null) as never,
      consecutivosLoteCon(null) as never,
    );

    await service.siguienteFactura(COP);

    expect(resoluciones.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, actualizacion] = resoluciones.findOneAndUpdate.mock.calls[0];
    expect(actualizacion).toEqual({ $inc: { nextNumber: 1 } });
  });

  it('usa el consecutivo simple de categoría FV cuando no hay resolución activa', async () => {
    // DIAN no es obligatorio para todos los clientes — sin resolución, factura
    // igual puede emitirse con el consecutivo simple, sin resolucionId.
    const service = servicio(null, { prefix: 'FV-A', nextNumber: 10 });

    // { new: true }, como en siguienteDocumento: la fila post-incremento es
    // la que se usa — el mock simula el mismo comportamiento.
    await expect(service.siguienteFactura(COP)).resolves.toEqual({
      prefijo: 'FV-A',
      numero: 11,
      completo: 'FV-A-11',
    });
  });

  it('busca el consecutivo de respaldo por categoría FV', async () => {
    const consecutivos = consecutivosCon({ prefix: 'FV', nextNumber: 1 });
    const service = new NumeracionService(
      resolucionesCon(null) as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );

    await service.siguienteFactura(COP);

    const [filtro] = consecutivos.findOneAndUpdate.mock.calls[0];
    expect(filtro).toMatchObject({ category: 'FV' });
  });

  it('rechaza cuando no hay resolución activa ni consecutivo FV configurado', async () => {
    const service = servicio(null, null);

    await expect(service.siguienteFactura(COP)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('NumeracionService.siguienteDocumento', () => {
  it('rechaza un código sin fila configurada — ya no se crea sola', async () => {
    // El comportamiento viejo (upsert on first use) tenía sentido cuando una
    // categoría era exactamente una fila. Con varios códigos posibles por
    // categoría no hay un default razonable que inventar: el administrador
    // declara el código en Documentos antes de poder emitir con él.
    const service = servicio(null, null);

    await expect(service.siguienteDocumento(COP, 'RC')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('continúa desde el contador existente', async () => {
    const service = servicio(null, { prefix: 'RC', nextNumber: 84 });

    await expect(service.siguienteDocumento(COP, 'RC')).resolves.toMatchObject({
      numero: 85,
    });
  });

  it('no aplica techo de rango: los internos no tienen resolución', async () => {
    const service = servicio(null, { prefix: 'NC', nextNumber: 999999 });

    await expect(service.siguienteDocumento(COP, 'NC')).resolves.toMatchObject({
      numero: 1000000,
    });
  });

  it('avanza uno por documento y nunca repite, arrancando desde un contador existente', async () => {
    const service = servicio(null, { prefix: 'RC', nextNumber: 0 });

    const numeros = [
      await service.siguienteDocumento(COP, 'RC'),
      await service.siguienteDocumento(COP, 'RC'),
      await service.siguienteDocumento(COP, 'RC'),
    ].map((n) => n.numero);

    expect(numeros).toEqual([1, 2, 3]);
    expect(new Set(numeros).size).toBe(3);
  });
});

describe('NumeracionService.siguienteLote', () => {
  it('arranca en 1 la primera vez, creando el contador', async () => {
    const service = servicio(null, null, null);

    await expect(service.siguienteLote(COP)).resolves.toBe(1);
  });

  it('continúa desde el contador existente', async () => {
    const service = servicio(null, null, { nextNumber: 14 });

    await expect(service.siguienteLote(COP)).resolves.toBe(15);
  });

  it('avanza uno por lote y nunca repite', async () => {
    const service = servicio(null, null, { nextNumber: 0 });

    const numeros = [
      await service.siguienteLote(COP),
      await service.siguienteLote(COP),
      await service.siguienteLote(COP),
    ];

    expect(numeros).toEqual([1, 2, 3]);
  });
});

describe('NumeracionService.siguienteDocumento — dentro de una transacción', () => {
  it('reenvía la sesión al findOneAndUpdate, para que un rollback deshaga también el número', async () => {
    const consecutivos = consecutivosCon({ prefix: 'RC', nextNumber: 5 });
    const service = new NumeracionService(
      resolucionesCon(null) as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );
    const sesionFalsa = { id: 'fake-session' } as unknown as ClientSession;

    await service.siguienteDocumento(COP, 'RC', sesionFalsa);

    const [, , opciones] = consecutivos.findOneAndUpdate.mock.calls[0];
    expect(opciones).toMatchObject({ session: sesionFalsa });
  });

  it('sigue funcionando sin sesión (todo llamador existente)', async () => {
    const service = servicio(null, { prefix: 'RC', nextNumber: 5 });

    await expect(service.siguienteDocumento(COP, 'RC')).resolves.toMatchObject({
      numero: 6,
    });
  });
});

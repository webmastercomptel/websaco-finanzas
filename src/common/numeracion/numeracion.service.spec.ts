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
        if (filtro.estado === 'active' && estado.estado !== 'active') {
          return Promise.resolve(null);
        }
        // The $expr ceiling: siguienteNumero must still be inside the range.
        if (
          (estado.siguienteNumero as number) > (estado.rangoHasta as number)
        ) {
          return Promise.resolve(null);
        }
        const previa = { ...estado };
        estado.siguienteNumero = (estado.siguienteNumero as number) + 1;
        return Promise.resolve(previa);
      },
    })),
    // Honours the estado filter, like the real collection: the service asks
    // specifically for an ACTIVE resolution when working out which of the two
    // failures happened, and a stub that ignores that would report "exhausted"
    // for a building whose resolution is merely switched off.
    findOne: jest.fn((filtro: Filtro) => ({
      lean: () => ({
        exec: () =>
          Promise.resolve(
            estado && filtro.estado === 'active' && estado.estado !== 'active'
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
          estado.siguienteNumero = (estado.siguienteNumero as number) + 1;
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
          // On upsert, $inc creates siguienteNumero at 1, returnDocument: 'after' returns post-image
          estado = { siguienteNumero: 1 };
          return Promise.resolve(estado);
        }
        // On normal update, increment first, then return post-image
        estado.siguienteNumero = (estado.siguienteNumero as number) + 1;
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
  numeroResolucion: '18764000001',
  prefijo: 'CONJ-2026',
  rangoDesde: 1,
  rangoHasta: 5000,
  siguienteNumero: 1,
  estado: 'active',
  ...over,
});

describe('NumeracionService.siguienteFactura', () => {
  it('entrega el número con su prefijo y el id de la resolución', async () => {
    const resolucion = resolucionActiva({ siguienteNumero: 1041 });
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
    const service = servicio(resolucionActiva({ siguienteNumero: 1 }));

    const emitidos = [
      await service.siguienteFactura(COP),
      await service.siguienteFactura(COP),
      await service.siguienteFactura(COP),
    ].map((n) => n.numero);

    expect(emitidos).toEqual([1, 2, 3]);
    expect(new Set(emitidos).size).toBe(3);
  });

  it('entrega el último número del rango', async () => {
    const service = servicio(resolucionActiva({ siguienteNumero: 5000 }));

    await expect(service.siguienteFactura(COP)).resolves.toMatchObject({
      numero: 5000,
    });
  });

  it('se niega cuando el rango se agotó, diciendo hasta dónde llegaba', async () => {
    const service = servicio(resolucionActiva({ siguienteNumero: 5001 }));

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
    const service = servicio(resolucionActiva({ estado: 'inactive' }));

    await expect(service.siguienteFactura(COP)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('funciona sin prefijo', async () => {
    const service = servicio(
      resolucionActiva({ prefijo: '', siguienteNumero: 7 }),
    );

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
    expect(actualizacion).toEqual({ $inc: { siguienteNumero: 1 } });
  });

  it('usa el consecutivo simple de categoría FV cuando no hay resolución activa', async () => {
    // DIAN no es obligatorio para todos los clientes — sin resolución, factura
    // igual puede emitirse con el consecutivo simple, sin resolucionId.
    const service = servicio(null, { prefijo: 'FV-A', siguienteNumero: 10 });

    // { returnDocument: 'after' }, como en siguienteDocumento: la fila post-incremento es
    // la que se usa — el mock simula el mismo comportamiento.
    await expect(service.siguienteFactura(COP)).resolves.toEqual({
      prefijo: 'FV-A',
      numero: 11,
      completo: 'FV-A-11',
    });
  });

  it('busca el consecutivo de respaldo por categoría FV', async () => {
    const consecutivos = consecutivosCon({ prefijo: 'FV', siguienteNumero: 1 });
    const service = new NumeracionService(
      resolucionesCon(null) as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );

    await service.siguienteFactura(COP);

    const [filtro] = consecutivos.findOneAndUpdate.mock.calls[0];
    expect(filtro).toMatchObject({ categoria: 'FV' });
  });

  it('rechaza cuando no hay resolución activa ni consecutivo FV configurado', async () => {
    const service = servicio(null, null);

    await expect(service.siguienteFactura(COP)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('NumeracionService.reservarBloqueFacturas', () => {
  // Unlike resolucionesCon/consecutivosCon above (built for siguienteFactura's
  // single-increment `{ $inc }` shape), these tests control the "before"
  // image findOneAndUpdate returns directly, per call — the atomic
  // clamp-and-increment itself happens inside Mongo's own aggregation
  // pipeline and isn't something a unit test can execute; what's tested here
  // is reservarBloqueFacturas' own JS-side math (clamping `otorgados` and
  // building the `numeros` array) against a controlled "before" state.

  it('otorga exactamente lo pedido cuando hay rango de sobra', async () => {
    const resolucion = resolucionActiva({ siguienteNumero: 1041 });
    const resoluciones = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(resolucion),
      })),
    };
    const service = new NumeracionService(
      resoluciones as never,
      consecutivosCon(null) as never,
      consecutivosLoteCon(null) as never,
    );

    await expect(service.reservarBloqueFacturas(COP, 3)).resolves.toEqual({
      numeros: [
        {
          prefijo: 'CONJ-2026',
          numero: 1041,
          completo: 'CONJ-2026-1041',
          resolucionId: resolucion._id,
        },
        {
          prefijo: 'CONJ-2026',
          numero: 1042,
          completo: 'CONJ-2026-1042',
          resolucionId: resolucion._id,
        },
        {
          prefijo: 'CONJ-2026',
          numero: 1043,
          completo: 'CONJ-2026-1043',
          resolucionId: resolucion._id,
        },
      ],
    });
  });

  it('nunca repite entre dos llamadas sucesivas', async () => {
    // Same atomicity concern as siguienteFactura's own "avanza uno por
    // documento y nunca repite" — here simulated across two calls of the
    // SAME requested amount (2), so the mock's own clamp math only needs to
    // stay correct for that one fixed cantidad.
    let estado = resolucionActiva({ siguienteNumero: 1 });
    const resoluciones = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => {
          const previa = { ...estado };
          const otorgados = Math.max(
            0,
            Math.min(2, estado.rangoHasta - estado.siguienteNumero + 1),
          );
          estado = {
            ...estado,
            siguienteNumero: estado.siguienteNumero + otorgados,
          };
          return Promise.resolve(previa);
        },
      })),
    };
    const service = new NumeracionService(
      resoluciones as never,
      consecutivosCon(null) as never,
      consecutivosLoteCon(null) as never,
    );

    const primero = await service.reservarBloqueFacturas(COP, 2);
    const segundo = await service.reservarBloqueFacturas(COP, 2);

    expect(primero.numeros.map((n) => n.numero)).toEqual([1, 2]);
    expect(segundo.numeros.map((n) => n.numero)).toEqual([3, 4]);
  });

  it('entrega hasta el último número disponible, otorgando menos que lo pedido', async () => {
    const resolucion = resolucionActiva({
      siguienteNumero: 4998,
      rangoHasta: 5000,
    });
    const resoluciones = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(resolucion),
      })),
    };
    const service = new NumeracionService(
      resoluciones as never,
      consecutivosCon(null) as never,
      consecutivosLoteCon(null) as never,
    );

    await expect(service.reservarBloqueFacturas(COP, 10)).resolves.toEqual({
      numeros: [
        {
          prefijo: 'CONJ-2026',
          numero: 4998,
          completo: 'CONJ-2026-4998',
          resolucionId: resolucion._id,
        },
        {
          prefijo: 'CONJ-2026',
          numero: 4999,
          completo: 'CONJ-2026-4999',
          resolucionId: resolucion._id,
        },
        {
          prefijo: 'CONJ-2026',
          numero: 5000,
          completo: 'CONJ-2026-5000',
          resolucionId: resolucion._id,
        },
      ],
    });
  });

  it('otorga cero cuando la resolución existe pero ya está agotada, sin caer al consecutivo FV', async () => {
    const resolucion = resolucionActiva({
      siguienteNumero: 5001,
      rangoHasta: 5000,
    });
    const resoluciones = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(resolucion),
      })),
    };
    const consecutivos = consecutivosCon({
      prefijo: 'FV',
      siguienteNumero: 1,
    });
    const service = new NumeracionService(
      resoluciones as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );

    await expect(service.reservarBloqueFacturas(COP, 5)).resolves.toEqual({
      numeros: [],
    });
    expect(consecutivos.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('usa el consecutivo FV de respaldo cuando no hay resolución activa, incrementando de una vez', async () => {
    const resoluciones = {
      findOneAndUpdate: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
    };
    const consecutivos = {
      // Declares both parameters (even though only the update is asserted
      // on below) so jest infers a two-element call tuple — see the same
      // note on resolucionesCon above.
      findOneAndUpdate: jest.fn((_filtro?: Filtro, _update?: Filtro) => ({
        exec: () => Promise.resolve({ prefijo: 'FV', siguienteNumero: 10 }),
      })),
    };
    const service = new NumeracionService(
      resoluciones as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );

    await expect(service.reservarBloqueFacturas(COP, 3)).resolves.toEqual({
      numeros: [
        { prefijo: 'FV', numero: 11, completo: 'FV-11' },
        { prefijo: 'FV', numero: 12, completo: 'FV-12' },
        { prefijo: 'FV', numero: 13, completo: 'FV-13' },
      ],
    });
    const [, actualizacion] = consecutivos.findOneAndUpdate.mock.calls[0];
    expect(actualizacion).toEqual({ $inc: { siguienteNumero: 3 } });
  });

  it('ignora una resolución inactiva y usa el consecutivo FV', async () => {
    // The filter is `{ estado: 'active' }` with no separate disambiguation
    // step (unlike siguienteFactura) — an inactive resolution simply never
    // matches, identical to no resolution existing at all.
    const resoluciones = resolucionesCon(
      resolucionActiva({ estado: 'inactive' }),
    );
    const consecutivos = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve({ prefijo: 'FV', siguienteNumero: 0 }),
      })),
    };
    const service = new NumeracionService(
      resoluciones as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );

    await expect(service.reservarBloqueFacturas(COP, 1)).resolves.toEqual({
      numeros: [{ prefijo: 'FV', numero: 1, completo: 'FV-1' }],
    });
  });

  it('funciona sin prefijo', async () => {
    const resolucion = resolucionActiva({ prefijo: '', siguienteNumero: 7 });
    const resoluciones = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(resolucion),
      })),
    };
    const service = new NumeracionService(
      resoluciones as never,
      consecutivosCon(null) as never,
      consecutivosLoteCon(null) as never,
    );

    await expect(service.reservarBloqueFacturas(COP, 1)).resolves.toMatchObject(
      {
        numeros: [{ completo: '7' }],
      },
    );
  });

  it('reserva en una sola operación de base de datos, sin importar cuántos números pida', async () => {
    const resolucion = resolucionActiva({ siguienteNumero: 1 });
    const resoluciones = {
      findOneAndUpdate: jest.fn(() => ({
        exec: () => Promise.resolve(resolucion),
      })),
    };
    const service = new NumeracionService(
      resoluciones as never,
      consecutivosCon(null) as never,
      consecutivosLoteCon(null) as never,
    );

    await service.reservarBloqueFacturas(COP, 50);

    expect(resoluciones.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('rechaza cuando no hay resolución activa ni consecutivo FV configurado', async () => {
    const service = servicio(null, null);

    await expect(service.reservarBloqueFacturas(COP, 5)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('cantidad 0 o negativa no llama a la base de datos', async () => {
    const resoluciones = { findOneAndUpdate: jest.fn() };
    const service = new NumeracionService(
      resoluciones as never,
      consecutivosCon(null) as never,
      consecutivosLoteCon(null) as never,
    );

    await expect(service.reservarBloqueFacturas(COP, 0)).resolves.toEqual({
      numeros: [],
    });
    expect(resoluciones.findOneAndUpdate).not.toHaveBeenCalled();
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
    const service = servicio(null, { prefijo: 'RC', siguienteNumero: 84 });

    await expect(service.siguienteDocumento(COP, 'RC')).resolves.toMatchObject({
      numero: 85,
    });
  });

  it('no aplica techo de rango: los internos no tienen resolución', async () => {
    const service = servicio(null, {
      prefijo: 'NC',
      siguienteNumero: 999999,
    });

    await expect(service.siguienteDocumento(COP, 'NC')).resolves.toMatchObject({
      numero: 1000000,
    });
  });

  it('avanza uno por documento y nunca repite, arrancando desde un contador existente', async () => {
    const service = servicio(null, { prefijo: 'RC', siguienteNumero: 0 });

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
    const service = servicio(null, null, { siguienteNumero: 14 });

    await expect(service.siguienteLote(COP)).resolves.toBe(15);
  });

  it('avanza uno por lote y nunca repite', async () => {
    const service = servicio(null, null, { siguienteNumero: 0 });

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
    const consecutivos = consecutivosCon({ prefijo: 'RC', siguienteNumero: 5 });
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
    const service = servicio(null, { prefijo: 'RC', siguienteNumero: 5 });

    await expect(service.siguienteDocumento(COP, 'RC')).resolves.toMatchObject({
      numero: 6,
    });
  });
});

describe('NumeracionService.reservarBloqueDocumentos', () => {
  /** Unlike `consecutivosCon` (fixed +1, used by `siguienteDocumento`'s own
   *  tests), this respects the actual `$inc.siguienteNumero` amount the
   *  update document carries — the whole point of this method is
   *  incrementing by `cantidad` in one atomic step, not by 1 repeatedly. */
  const consecutivosBloqueCon = (fila: Record<string, unknown> | null) => {
    const estado = fila ? { ...fila } : null;
    return {
      findOneAndUpdate: jest.fn(
        (
          _filtro: unknown,
          update: { $inc: { siguienteNumero: number } },
          _opciones?: unknown,
        ) => ({
          exec: () => {
            if (!estado) return Promise.resolve(null);
            const previo = { ...estado };
            estado.siguienteNumero =
              (estado.siguienteNumero as number) + update.$inc.siguienteNumero;
            return Promise.resolve(previo);
          },
        }),
      ),
    };
  };

  it('rechaza un código sin fila configurada', async () => {
    const service = new NumeracionService(
      resolucionesCon(null) as never,
      consecutivosBloqueCon(null) as never,
      consecutivosLoteCon(null) as never,
    );

    await expect(
      service.reservarBloqueDocumentos(COP, 'RC', 5),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reserva `cantidad` números consecutivos en UNA sola operación, arrancando después del contador existente', async () => {
    const consecutivos = consecutivosBloqueCon({
      prefijo: 'RC',
      siguienteNumero: 10,
    });
    const service = new NumeracionService(
      resolucionesCon(null) as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );

    const { numeros } = await service.reservarBloqueDocumentos(COP, 'RC', 3);

    expect(numeros.map((n) => n.numero)).toEqual([11, 12, 13]);
    expect(consecutivos.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('cantidad 0 no toca la base y devuelve un array vacío', async () => {
    const consecutivos = consecutivosBloqueCon({
      prefijo: 'RC',
      siguienteNumero: 10,
    });
    const service = new NumeracionService(
      resolucionesCon(null) as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );

    const { numeros } = await service.reservarBloqueDocumentos(COP, 'RC', 0);

    expect(numeros).toEqual([]);
    expect(consecutivos.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('llamadas consecutivas nunca repiten un número', async () => {
    const consecutivos = consecutivosBloqueCon({
      prefijo: 'RC',
      siguienteNumero: 0,
    });
    const service = new NumeracionService(
      resolucionesCon(null) as never,
      consecutivos as never,
      consecutivosLoteCon(null) as never,
    );

    const primero = await service.reservarBloqueDocumentos(COP, 'RC', 2);
    const segundo = await service.reservarBloqueDocumentos(COP, 'RC', 2);

    expect(primero.numeros.map((n) => n.numero)).toEqual([1, 2]);
    expect(segundo.numeros.map((n) => n.numero)).toEqual([3, 4]);
  });
});

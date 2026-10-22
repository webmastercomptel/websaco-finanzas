import { Types } from 'mongoose';
import { InmueblesBajaService } from './inmuebles-baja.service';

const COP = new Types.ObjectId();
const tenant = { resolveCoPropertyId: () => COP } as never;
const ACTOR = { accountId: 'acc-1', nombre: 'Contadora Ana' };

type Filtro = Record<string, unknown>;

interface Unidad {
  id: string;
  codigo: string;
  estado?: 'active' | 'inactive';
  copropiedad?: Types.ObjectId;
}

/** A fake session whose writes only become real when the transaction
 *  callback resolves — what `withTransaction` guarantees. */
interface SesionFalsa {
  pendientes: (() => void)[];
  abortada: boolean;
}

/** Honors the tenant filter, the `estado` filter and the transaction like
 *  Mongo would: inside a session the state change is staged and applied only on
 *  commit, so "the audit failed, nothing persisted" is proven by the final
 *  state and not by a mock call count. */
const inmueblesModeloCon = (unidades: Unidad[]) => {
  const estados = new Map(unidades.map((u) => [u.id, u.estado ?? 'active']));
  const filtrosFind: Filtro[] = [];
  const llamadasUpdateMany: {
    filtro: Filtro;
    cambios: Filtro;
    opciones?: { session?: SesionFalsa };
  }[] = [];
  return {
    estados,
    filtrosFind,
    llamadasUpdateMany,
    find: jest.fn((filtro: Filtro) => {
      filtrosFind.push(filtro);
      const visibles = unidades.filter(
        (u) =>
          !filtro.copropiedadId ||
          (u.copropiedad ?? COP).equals(filtro.copropiedadId as Types.ObjectId),
      );
      const cadena = {
        select: () => cadena,
        lean: () => cadena,
        exec: () =>
          Promise.resolve(
            visibles.map((u) => ({
              _id: u.id,
              codigo: u.codigo,
              estado: estados.get(u.id),
            })),
          ),
      };
      return cadena;
    }),
    updateMany: jest.fn(
      (
        filtro: Filtro,
        { $set }: { $set: Filtro },
        opciones?: { session?: SesionFalsa },
      ) => {
        llamadasUpdateMany.push({ filtro, cambios: $set, opciones });
        const ids = (filtro._id as { $in: string[] }).$in;
        const aplicables = ids.filter(
          (id) => !filtro.estado || estados.get(id) === filtro.estado,
        );
        const aplicar = () => {
          for (const id of aplicables) estados.set(id, $set.estado as never);
        };
        if (opciones?.session) opciones.session.pendientes.push(aplicar);
        else aplicar();
        return {
          exec: () => Promise.resolve({ modifiedCount: aplicables.length }),
        };
      },
    ),
    deleteOne: jest.fn(),
    deleteMany: jest.fn(),
    findOneAndDelete: jest.fn(),
  };
};

const copropiedadModeloCon = () => ({
  findById: jest.fn(() => {
    const cadena = {
      select: () => cadena,
      lean: () => cadena,
      exec: () => Promise.resolve({ codigo: '0001', nombre: 'Torres del Sol' }),
    };
    return cadena;
  }),
  deleteOne: jest.fn(),
  deleteMany: jest.fn(),
});

const conexionFalsa = () => {
  const sesiones: SesionFalsa[] = [];
  return {
    sesiones,
    startSession: () => {
      const sesion: SesionFalsa = { pendientes: [], abortada: false };
      sesiones.push(sesion);
      return Promise.resolve({
        ...sesion,
        withTransaction: async (fn: () => Promise<void>) => {
          try {
            await fn();
            sesion.pendientes.forEach((aplicar) => aplicar());
          } catch (err) {
            sesion.abortada = true;
            throw err;
          }
        },
        endSession: () => Promise.resolve(undefined),
        // The service hands THIS object to updateMany/registrar.
        get pendientes() {
          return sesion.pendientes;
        },
      });
    },
  };
};

const montar = (unidades: Unidad[]) => {
  const inmuebles = inmueblesModeloCon(unidades);
  const copropiedades = copropiedadModeloCon();
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const conexion = conexionFalsa();
  const service = new InmueblesBajaService(
    inmuebles as never,
    copropiedades as never,
    tenant,
    auditoria as never,
    conexion as never,
  );
  return { service, inmuebles, copropiedades, auditoria, conexion };
};

describe('InmueblesBajaService.darDeBaja', () => {
  it('pasa a inactivo los inmuebles activos encontrados, con un solo updateMany filtrado por activo y copropiedad', async () => {
    const { service, inmuebles } = montar([
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: '302' },
    ]);

    const resultado = await service.darDeBaja(
      { codigos: ['301', '302'] },
      ACTOR,
    );

    expect(resultado).toEqual({
      solicitados: 2,
      dadosDeBaja: 2,
      yaInactivos: [],
      noEncontrados: [],
    });
    expect(inmuebles.updateMany).toHaveBeenCalledTimes(1);
    expect(inmuebles.llamadasUpdateMany[0]).toMatchObject({
      filtro: {
        _id: { $in: ['inm-1', 'inm-2'] },
        copropiedadId: COP,
        estado: 'active',
      },
      cambios: { estado: 'inactive' },
    });
    expect([...inmuebles.estados.values()]).toEqual(['inactive', 'inactive']);
  });

  it('un inmueble que ya estaba inactivo se reporta en yaInactivos y no se vuelve a tocar', async () => {
    const { service, inmuebles, auditoria } = montar([
      { id: 'inm-1', codigo: '301', estado: 'inactive' },
    ]);

    const resultado = await service.darDeBaja({ codigos: ['301'] }, ACTOR);

    expect(resultado).toEqual({
      solicitados: 1,
      dadosDeBaja: 0,
      yaInactivos: ['301'],
      noEncontrados: [],
    });
    expect(inmuebles.updateMany).not.toHaveBeenCalled();
    // Nada cambió: no hay nada que auditar.
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('un código que no existe se reporta en noEncontrados', async () => {
    const { service, inmuebles } = montar([{ id: 'inm-1', codigo: '301' }]);

    const resultado = await service.darDeBaja(
      { codigos: ['301', '999'] },
      ACTOR,
    );

    expect(resultado.dadosDeBaja).toBe(1);
    expect(resultado.noEncontrados).toEqual(['999']);
    expect(inmuebles.llamadasUpdateMany[0].filtro._id).toEqual({
      $in: ['inm-1'],
    });
  });

  it('encuentra el código con otra capitalización o espacios', async () => {
    const { service } = montar([{ id: 'inm-1', codigo: 'Torre A-301' }]);

    const resultado = await service.darDeBaja(
      { codigos: ['  torre a-301 '] },
      ACTOR,
    );

    expect(resultado.dadosDeBaja).toBe(1);
    expect(resultado.noEncontrados).toEqual([]);
  });

  it('un código repetido en la petición (también con otra forma) cuenta una sola vez', async () => {
    const { service, inmuebles } = montar([{ id: 'inm-1', codigo: 'A-1' }]);

    const resultado = await service.darDeBaja(
      { codigos: ['A-1', ' a-1 ', 'A-1', 'X-9', 'x-9'] },
      ACTOR,
    );

    expect(resultado.solicitados).toBe(2);
    expect(resultado.dadosDeBaja).toBe(1);
    expect(resultado.noEncontrados).toEqual(['X-9']);
    expect(inmuebles.llamadasUpdateMany[0].filtro._id).toEqual({
      $in: ['inm-1'],
    });
  });

  it('dos unidades heredadas que solo difieren por mayúsculas se retiran las dos con un código; la inactiva va a yaInactivos', async () => {
    const { service, inmuebles } = montar([
      { id: 'inm-1', codigo: 'A-1' },
      { id: 'inm-2', codigo: 'a-1' },
      { id: 'inm-3', codigo: 'A-1 ', estado: 'inactive' },
    ]);

    const resultado = await service.darDeBaja({ codigos: ['a-1'] }, ACTOR);

    expect(resultado).toEqual({
      solicitados: 1,
      dadosDeBaja: 2,
      yaInactivos: ['A-1 '],
      noEncontrados: [],
    });
    expect(inmuebles.estados.get('inm-1')).toBe('inactive');
    expect(inmuebles.estados.get('inm-2')).toBe('inactive');
  });

  it('tenencia: el código de OTRA copropiedad es noEncontrados y no se toca', async () => {
    const OTRA = new Types.ObjectId();
    const { service, inmuebles } = montar([
      { id: 'inm-ajeno', codigo: '301', copropiedad: OTRA },
    ]);

    const resultado = await service.darDeBaja({ codigos: ['301'] }, ACTOR);

    expect(resultado.noEncontrados).toEqual(['301']);
    expect(resultado.dadosDeBaja).toBe(0);
    expect(inmuebles.updateMany).not.toHaveBeenCalled();
    expect(inmuebles.estados.get('inm-ajeno')).toBe('active');
    for (const filtro of inmuebles.filtrosFind) {
      expect(filtro.copropiedadId).toBe(COP);
    }
  });

  it('nunca borra nada: ningún modelo recibe una operación de borrado', async () => {
    const { service, inmuebles, copropiedades } = montar([
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: '302', estado: 'inactive' },
    ]);

    await service.darDeBaja({ codigos: ['301', '302', '999'] }, ACTOR);

    for (const modelo of [inmuebles, copropiedades]) {
      expect(modelo.deleteOne).not.toHaveBeenCalled();
      expect(modelo.deleteMany).not.toHaveBeenCalled();
    }
    expect(inmuebles.findOneAndDelete).not.toHaveBeenCalled();
  });
});

describe('InmueblesBajaService.darDeBaja — auditoría y transacción', () => {
  it('escribe UNA entrada de auditoría por petición, con quién, la acción y los códigos', async () => {
    const { service, auditoria } = montar([
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: '302' },
      { id: 'inm-3', codigo: '303', estado: 'inactive' },
    ]);

    await service.darDeBaja({ codigos: ['301', '302', '303', '999'] }, ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    expect(auditoria.registrar).toHaveBeenCalledWith(
      {
        actorAccountId: 'acc-1',
        actorNombre: 'Contadora Ana',
        accion: 'dar-de-baja',
        entidadTipo: 'inmueble',
        entidadId: 'inm-1',
        entidadEtiqueta:
          '2 inmueble(s) dados de baja en 0001 Torres del Sol: 301, 302',
      },
      expect.anything(),
    );
  });

  it('el retiro y la auditoría comparten la MISMA sesión de transacción', async () => {
    const { service, inmuebles, auditoria, conexion } = montar([
      { id: 'inm-1', codigo: '301' },
    ]);

    await service.darDeBaja({ codigos: ['301'] }, ACTOR);

    expect(conexion.sesiones).toHaveLength(1);
    const sesionDelUpdate = inmuebles.llamadasUpdateMany[0].opciones?.session;
    const llamadas = auditoria.registrar.mock.calls as [unknown, unknown][];
    expect(sesionDelUpdate).toBeDefined();
    expect(llamadas[0][1]).toBe(sesionDelUpdate);
    expect(inmuebles.estados.get('inm-1')).toBe('inactive');
  });

  it('si la auditoría falla, la transacción se revierte: ningún inmueble queda dado de baja', async () => {
    const { service, inmuebles, auditoria, conexion } = montar([
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: '302' },
    ]);
    auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));

    await expect(
      service.darDeBaja({ codigos: ['301', '302'] }, ACTOR),
    ).rejects.toThrow('sin auditoría');

    expect(inmuebles.estados.get('inm-1')).toBe('active');
    expect(inmuebles.estados.get('inm-2')).toBe('active');
    expect(conexion.sesiones).toHaveLength(1);

    // Reintentar retira de verdad (no responde "ya inactivos") y deja la entrada.
    const reintento = await service.darDeBaja(
      { codigos: ['301', '302'] },
      ACTOR,
    );
    expect(reintento.dadosDeBaja).toBe(2);
    expect(reintento.yaInactivos).toEqual([]);
    expect(auditoria.registrar).toHaveBeenCalledTimes(2);
    expect(inmuebles.estados.get('inm-1')).toBe('inactive');
  });

  /** The service reads the units as active, then ANOTHER request retires
   *  `yaRetiradas` before this one's `updateMany` runs. */
  const conCarrera = (
    inmuebles: ReturnType<typeof inmueblesModeloCon>,
    leidas: { id: string; codigo: string }[],
    yaRetiradas: string[],
  ) => {
    inmuebles.find.mockImplementationOnce(() => {
      const cadena = {
        select: () => cadena,
        lean: () => cadena,
        exec: () => {
          for (const id of yaRetiradas) inmuebles.estados.set(id, 'inactive');
          return Promise.resolve(
            leidas.map((u) => ({
              _id: u.id,
              codigo: u.codigo,
              estado: 'active' as const,
            })),
          );
        },
      };
      return cadena;
    });
  };

  it('la cuenta del resultado y de la auditoría sale de modifiedCount: una unidad que otra llamada ya retiró no se cuenta dos veces', async () => {
    const unidades = [
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: '302' },
    ];
    const { service, inmuebles, auditoria } = montar(unidades);
    conCarrera(inmuebles, unidades, ['inm-2']);

    const resultado = await service.darDeBaja(
      { codigos: ['301', '302'] },
      ACTOR,
    );

    expect(resultado.dadosDeBaja).toBe(1);
    const llamadas = auditoria.registrar.mock.calls as [
      { entidadEtiqueta: string },
      unknown,
    ][];
    expect(llamadas[0][0].entidadEtiqueta).toContain('1 inmueble(s)');
  });

  it('si modifiedCount es 0 no escribe auditoría', async () => {
    const unidades = [{ id: 'inm-1', codigo: '301' }];
    const { service, inmuebles, auditoria } = montar(unidades);
    conCarrera(inmuebles, unidades, ['inm-1']);

    const resultado = await service.darDeBaja({ codigos: ['301'] }, ACTOR);

    expect(resultado.dadosDeBaja).toBe(0);
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('la auditoría lista como mucho 50 códigos y cuenta el resto', async () => {
    const unidades = Array.from({ length: 60 }, (_, i) => ({
      id: `inm-${i}`,
      codigo: `U${i}`,
    }));
    const { service, auditoria } = montar(unidades);

    await service.darDeBaja({ codigos: unidades.map((u) => u.codigo) }, ACTOR);

    const llamadas = auditoria.registrar.mock.calls as [
      { entidadEtiqueta: string },
      unknown,
    ][];
    const { entidadEtiqueta } = llamadas[0][0];
    expect(entidadEtiqueta).toContain('60 inmueble(s)');
    expect(entidadEtiqueta).toContain('U49');
    expect(entidadEtiqueta).not.toContain('U50,');
    expect(entidadEtiqueta).toContain('y 10 más');
  });
});

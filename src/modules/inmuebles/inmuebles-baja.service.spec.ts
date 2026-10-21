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

/** Honors the tenant filter like Mongo would: a unit of ANOTHER coproperty is
 *  only returned if the service forgot `copropiedadId` — which the tenancy test
 *  below turns into a failure. */
const inmueblesModeloCon = (unidades: Unidad[]) => {
  const filtrosFind: Filtro[] = [];
  const actualizaciones: { filtro: Filtro; cambios: Filtro }[] = [];
  return {
    filtrosFind,
    actualizaciones,
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
              estado: u.estado ?? 'active',
            })),
          ),
      };
      return cadena;
    }),
    updateMany: jest.fn((filtro: Filtro, { $set }: { $set: Filtro }) => {
      actualizaciones.push({ filtro, cambios: $set });
      return { exec: () => Promise.resolve({ modifiedCount: 1 }) };
    }),
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

const montar = (unidades: Unidad[]) => {
  const inmuebles = inmueblesModeloCon(unidades);
  const copropiedades = copropiedadModeloCon();
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const service = new InmueblesBajaService(
    inmuebles as never,
    copropiedades as never,
    tenant,
    auditoria as never,
  );
  return { service, inmuebles, copropiedades, auditoria };
};

describe('InmueblesBajaService.darDeBaja', () => {
  it('pasa a inactivo los inmuebles activos encontrados, con un solo updateMany', async () => {
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
    expect(inmuebles.actualizaciones[0]).toEqual({
      filtro: { _id: { $in: ['inm-1', 'inm-2'] }, copropiedadId: COP },
      cambios: { estado: 'inactive' },
    });
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
    expect(inmuebles.actualizaciones[0].filtro).toEqual({
      _id: { $in: ['inm-1'] },
      copropiedadId: COP,
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
    expect(inmuebles.actualizaciones[0].filtro._id).toEqual({
      $in: ['inm-1'],
    });
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

  it('escribe UNA entrada de auditoría por petición, con quién, la acción y los códigos', async () => {
    const { service, auditoria } = montar([
      { id: 'inm-1', codigo: '301' },
      { id: 'inm-2', codigo: '302' },
      { id: 'inm-3', codigo: '303', estado: 'inactive' },
    ]);

    await service.darDeBaja({ codigos: ['301', '302', '303', '999'] }, ACTOR);

    expect(auditoria.registrar).toHaveBeenCalledTimes(1);
    expect(auditoria.registrar).toHaveBeenCalledWith({
      actorAccountId: 'acc-1',
      actorNombre: 'Contadora Ana',
      accion: 'dar-de-baja',
      entidadTipo: 'inmueble',
      entidadId: 'inm-1',
      entidadEtiqueta:
        '2 inmueble(s) dados de baja en 0001 Torres del Sol: 301, 302',
    });
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
    ][];
    const { entidadEtiqueta } = llamadas[0][0];
    expect(entidadEtiqueta).toContain('60 inmueble(s)');
    expect(entidadEtiqueta).toContain('U49');
    expect(entidadEtiqueta).not.toContain('U50,');
    expect(entidadEtiqueta).toContain('y 10 más');
  });

  it('si la auditoría falla, la petición falla (el retiro es idempotente y se puede repetir)', async () => {
    const { service, auditoria } = montar([{ id: 'inm-1', codigo: '301' }]);
    auditoria.registrar.mockRejectedValueOnce(new Error('sin auditoría'));

    await expect(
      service.darDeBaja({ codigos: ['301'] }, ACTOR),
    ).rejects.toThrow('sin auditoría');
  });
});

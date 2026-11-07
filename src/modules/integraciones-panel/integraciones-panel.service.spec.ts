import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { HttpException } from '@nestjs/common';
import { Types } from 'mongoose';
import { IntegracionesPanelService } from './integraciones-panel.service';

const ID = '670000000000000000000001';
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);

const copropiedad = (extra: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(ID),
  nombre: 'Conjunto Los Pinos',
  nit: '900123456',
  digitoVerificacion: '7',
  estado: 'active',
  comptableEmpresaId: null,
  ...extra,
});

/** `find`/`findOne` chains end in `.lean().exec()`; this resolves to `valor`. */
const cadena = (valor: unknown) => {
  const q: Record<string, jest.Mock> = {};
  for (const metodo of ['sort', 'skip', 'limit', 'lean', 'select']) {
    q[metodo] = jest.fn(() => q);
  }
  q.exec = jest.fn(() => Promise.resolve(valor));
  return q;
};

interface OpcionesModelo {
  docs?: unknown[];
  total?: number;
  doc?: unknown;
  relectura?: unknown;
  ocupado?: boolean;
  matched?: number;
  errorEscritura?: unknown;
}

/**
 * Mongo's driver rejects with plain objects carrying `code`/`keyPattern`; the
 * tests need that exact object back, typed as an Error only for the linter.
 */
const comoError = (valor: unknown): Error => valor as Error;

type Filtro = Record<string, unknown>;
type Cadena = ReturnType<typeof cadena>;
type Ejecutable<T> = { exec: () => Promise<T> };
type ResultadoEscritura = { matchedCount: number; modifiedCount: number };

const crearModelo = (o: OpcionesModelo = {}) => {
  const lista = cadena(o.docs ?? []);
  const find = jest.fn<Cadena, [Filtro]>(() => lista);
  const findOne = jest
    .fn<Cadena, [Filtro]>()
    .mockReturnValueOnce(cadena(o.doc === undefined ? copropiedad() : o.doc))
    .mockReturnValue(cadena(o.relectura ?? null));
  const exists = jest.fn<Ejecutable<unknown>, [Filtro]>(() => ({
    exec: () => Promise.resolve(o.ocupado ? { _id: 'otra' } : null),
  }));
  const updateOne = jest.fn<Ejecutable<ResultadoEscritura>, [Filtro, Filtro]>(
    () => ({
      exec: () =>
        o.errorEscritura
          ? Promise.reject(comoError(o.errorEscritura))
          : Promise.resolve({
              matchedCount: o.matched ?? 1,
              modifiedCount: o.matched ?? 1,
            }),
    }),
  );
  const countDocuments = jest.fn<Ejecutable<number>, [Filtro]>(() => ({
    exec: () => Promise.resolve(o.total ?? 0),
  }));
  return { find, findOne, exists, updateOne, countDocuments, lista };
};

const servicioCon = (o: OpcionesModelo = {}) => {
  const modelo = crearModelo(o);
  return {
    modelo,
    servicio: new IntegracionesPanelService(modelo as never),
  };
};

/** Awaits a call that must reject and returns what it threw. */
const capturar = async (promesa: Promise<unknown>): Promise<HttpException> => {
  try {
    await promesa;
  } catch (e) {
    return e as HttpException;
  }
  throw new Error('debió lanzar');
};

describe('IntegracionesPanelService.listar', () => {
  it('lista solo copropiedades activas, ordenadas por nombre y con id como desempate', async () => {
    const { servicio, modelo } = servicioCon({
      docs: [copropiedad()],
      total: 1,
    });

    const res = await servicio.listar({});

    expect(modelo.find).toHaveBeenCalledWith({ estado: 'active' });
    expect(modelo.lista.sort).toHaveBeenCalledWith({ nombre: 1, _id: 1 });
    expect(res.total).toBe(1);
    expect(res.items[0]).toMatchObject({
      id: ID,
      nombre: 'Conjunto Los Pinos',
      nit: '900123456-7',
    });
  });

  it('el total cuenta el filtro completo, no la página', async () => {
    const { servicio, modelo } = servicioCon({ docs: [], total: 240 });

    const res = await servicio.listar({ q: 'pinos', limite: 10 });

    expect(res.total).toBe(240);
    expect(modelo.countDocuments).toHaveBeenCalledWith(
      modelo.find.mock.calls[0][0],
    );
  });

  it('pagina con skip y limit; por defecto página 1 de 50', async () => {
    const { servicio, modelo } = servicioCon();

    await servicio.listar({});
    expect(modelo.lista.skip).toHaveBeenLastCalledWith(0);
    expect(modelo.lista.limit).toHaveBeenLastCalledWith(50);

    await servicio.listar({ pagina: 3, limite: 20 });
    expect(modelo.lista.skip).toHaveBeenLastCalledWith(40);
    expect(modelo.lista.limit).toHaveBeenLastCalledWith(20);
  });

  it('nunca pide más de 100 por página aunque llegue un límite mayor', async () => {
    const { servicio, modelo } = servicioCon();

    await servicio.listar({ limite: 500 });

    expect(modelo.lista.limit).toHaveBeenLastCalledWith(100);
  });

  it('busca en nombre, NIT y código sin distinguir mayúsculas', async () => {
    const { servicio, modelo } = servicioCon();

    await servicio.listar({ q: 'pinos' });

    const filtro = modelo.find.mock.calls[0][0] as {
      $or: Array<Record<string, { $regex: string; $options: string }>>;
    };
    expect(filtro.$or.map((c) => Object.keys(c)[0]).sort()).toEqual([
      'codigo',
      'nit',
      'nombre',
    ]);
    expect(filtro.$or[0][Object.keys(filtro.$or[0])[0]].$options).toBe('i');
  });

  it('el texto de búsqueda se escapa: `.*(\\$` es texto, no una expresión', async () => {
    const { servicio, modelo } = servicioCon();
    const peligroso = 'x.*(\\$';

    await servicio.listar({ q: peligroso });

    const filtro = modelo.find.mock.calls[0][0] as {
      $or: Array<{ nombre?: { $regex: string } }>;
    };
    const patron = new RegExp(filtro.$or[1].nombre?.$regex ?? '', 'i');
    // Compiling it did not throw, it matches the literal text and nothing else.
    expect(patron.test(peligroso)).toBe(true);
    expect(patron.test('xaaaa')).toBe(false);
    expect(patron.test('cualquier nombre')).toBe(false);
  });

  it('con id devuelve a lo sumo ese registro', async () => {
    const { servicio, modelo } = servicioCon();

    await servicio.listar({ id: ID.toUpperCase() });

    const filtro = modelo.find.mock.calls[0][0] as {
      _id: Types.ObjectId;
      estado: string;
    };
    expect(filtro._id.toString()).toBe(ID);
    expect(filtro.estado).toBe('active');
  });

  it('una copropiedad inactiva no aparece: el filtro la excluye siempre', async () => {
    const { servicio, modelo } = servicioCon();

    await servicio.listar({ q: 'x', id: ID });

    expect(modelo.find.mock.calls[0][0]).toMatchObject({ estado: 'active' });
  });
});

describe('IntegracionesPanelService.fijarVinculo', () => {
  describe('registro y sistema', () => {
    it('copropiedad inexistente: 404 REGISTRO_NO_ENCONTRADO sin escribir', async () => {
      const { servicio, modelo } = servicioCon({ doc: null });

      const e = await capturar(
        servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A }),
      );

      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.getResponse()).toMatchObject({ code: 'REGISTRO_NO_ENCONTRADO' });
      expect(modelo.updateOne).not.toHaveBeenCalled();
    });

    it('solo busca entre las activas: una inactiva da 404 (revisión 4)', async () => {
      const { servicio, modelo } = servicioCon({ doc: null });

      await capturar(
        servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A }),
      );

      expect(modelo.findOne.mock.calls[0][0]).toMatchObject({
        estado: 'active',
      });
    });

    it.each(['finanzas', 'nomina', 'otro'])(
      'sistema %s: 422 SISTEMA_NO_SOPORTADO sin escribir',
      async (sistema) => {
        const { servicio, modelo } = servicioCon();

        const e = await capturar(
          servicio.fijarVinculo(ID, { sistema, registroId: A }),
        );

        expect(e).toBeInstanceOf(UnprocessableEntityException);
        expect(e.getResponse()).toMatchObject({ code: 'SISTEMA_NO_SOPORTADO' });
        expect(modelo.updateOne).not.toHaveBeenCalled();
      },
    );
  });

  describe('reglas de valor', () => {
    it('poner un vínculo nuevo escribe y devuelve sistema y registroId', async () => {
      const { servicio, modelo } = servicioCon();

      const res = await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: A,
      });

      expect(res).toEqual({ sistema: 'comptable', registroId: A });
      expect(modelo.updateOne).toHaveBeenCalledTimes(1);
    });

    it('el mismo valor que ya tiene es idempotente: 200 sin escribir', async () => {
      const { servicio, modelo } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: A }),
      });

      const res = await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: A,
      });

      expect(res).toEqual({ sistema: 'comptable', registroId: A });
      expect(modelo.updateOne).not.toHaveBeenCalled();
      expect(modelo.exists).not.toHaveBeenCalled();
    });

    it('borrar lo que ya no tiene es idempotente', async () => {
      const { servicio, modelo } = servicioCon();

      const res = await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: null,
      });

      expect(res).toEqual({ sistema: 'comptable', registroId: null });
      expect(modelo.updateOne).not.toHaveBeenCalled();
    });

    it('un valor distinto sin forzar: 409 VINCULO_EXISTENTE con valorActual y sin escribir', async () => {
      const { servicio, modelo } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: A }),
      });

      const e = await capturar(
        servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: B }),
      );

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse()).toMatchObject({
        code: 'VINCULO_EXISTENTE',
        valorActual: A,
      });
      expect(modelo.updateOne).not.toHaveBeenCalled();
    });

    it('con forzar pisa el valor, condicionado al valor que leyó', async () => {
      const { servicio, modelo } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: A }),
      });

      const res = await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: B,
        forzar: true,
      });

      expect(res).toEqual({ sistema: 'comptable', registroId: B });
      const [filtro, cambio] = modelo.updateOne.mock.calls[0] as unknown as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(filtro).toMatchObject({ comptableEmpresaId: A });
      expect(cambio).toEqual({ $set: { comptableEmpresaId: B } });
    });

    it('si no tenía vínculo, el filtro acepta null o clave ausente', async () => {
      const { servicio, modelo } = servicioCon();

      await servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A });

      const [filtro] = modelo.updateOne.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ];
      expect(filtro).toHaveProperty('comptableEmpresaId', null);
    });

    it('null con esperado igual al actual borra', async () => {
      const { servicio, modelo } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: A }),
      });

      const res = await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: null,
        esperado: A.toUpperCase(),
      });

      expect(res).toEqual({ sistema: 'comptable', registroId: null });
      expect(modelo.updateOne.mock.calls[0][1]).toEqual({
        $set: { comptableEmpresaId: null },
      });
    });

    it('null con esperado distinto del actual: 409 sin escribir', async () => {
      const { servicio, modelo } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: A }),
      });

      const e = await capturar(
        servicio.fijarVinculo(ID, {
          sistema: 'comptable',
          registroId: null,
          esperado: B,
        }),
      );

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse()).toMatchObject({
        code: 'VINCULO_EXISTENTE',
        valorActual: A,
      });
      expect(modelo.updateOne).not.toHaveBeenCalled();
    });

    it('null sin esperado borra', async () => {
      const { servicio, modelo } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: A }),
      });

      await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: null,
      });

      expect(modelo.updateOne.mock.calls[0][1]).toEqual({
        $set: { comptableEmpresaId: null },
      });
    });

    it('guarda el id en minúsculas y recortado', async () => {
      const { servicio, modelo } = servicioCon();

      const res = await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: `  ${'A'.repeat(24)} `,
      });

      expect(res.registroId).toBe(A);
      expect(modelo.updateOne.mock.calls[0][1]).toEqual({
        $set: { comptableEmpresaId: A },
      });
    });
  });

  describe('unicidad', () => {
    it('un id ya usado por otra copropiedad: 409 REGISTRO_YA_VINCULADO, excluyendo a la propia', async () => {
      const { servicio, modelo } = servicioCon({ ocupado: true });

      const e = await capturar(
        servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A }),
      );

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse()).toMatchObject({ code: 'REGISTRO_YA_VINCULADO' });
      expect(modelo.updateOne).not.toHaveBeenCalled();
      const filtro = modelo.exists.mock.calls[0] as unknown as [
        { comptableEmpresaId: string; _id: { $ne: unknown } },
      ];
      expect(filtro[0].comptableEmpresaId).toBe(A);
      expect(String(filtro[0]._id.$ne)).toBe(ID);
    });

    it('borrar no consulta la unicidad', async () => {
      const { servicio, modelo } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: A }),
      });

      await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: null,
      });

      expect(modelo.exists).not.toHaveBeenCalled();
    });
  });

  describe('concurrencia (revisión 2)', () => {
    it('si otro cambió el valor entre la lectura y la escritura: 409 con el valor releído', async () => {
      const { servicio } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: A }),
        matched: 0,
        relectura: copropiedad({ comptableEmpresaId: B }),
      });

      const e = await capturar(
        servicio.fijarVinculo(ID, {
          sistema: 'comptable',
          registroId: A.replace('a', 'c'),
          forzar: true,
        }),
      );

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse()).toMatchObject({
        code: 'VINCULO_EXISTENTE',
        valorActual: B,
      });
    });

    it('un choque con el índice único (E11000 sobre el campo): 409 REGISTRO_YA_VINCULADO', async () => {
      const { servicio } = servicioCon({
        errorEscritura: {
          code: 11000,
          keyPattern: { comptableEmpresaId: 1 },
        },
      });

      const e = await capturar(
        servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A }),
      );

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse()).toMatchObject({ code: 'REGISTRO_YA_VINCULADO' });
    });

    it('un E11000 de otra clave o cualquier otro error no se traduce', async () => {
      const otro = { code: 11000, keyPattern: { codigo: 1 } };
      const { servicio } = servicioCon({ errorEscritura: otro });

      await expect(
        servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A }),
      ).rejects.toBe(otro);
    });
  });

  describe('Administración ya no es un sistema vinculable', () => {
    it('administracion: 422 SISTEMA_NO_SOPORTADO sin escribir ni tocar la bandera de gestión de edificios', async () => {
      const { servicio, modelo } = servicioCon();

      const e = await capturar(
        servicio.fijarVinculo(ID, { sistema: 'administracion', registroId: B }),
      );

      expect(e.getResponse()).toMatchObject({ code: 'SISTEMA_NO_SOPORTADO' });
      expect(modelo.updateOne).not.toHaveBeenCalled();
    });

    it('comptable no toca esa bandera', async () => {
      const { servicio, modelo } = servicioCon();

      await servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A });

      expect(JSON.stringify(modelo.updateOne.mock.calls[0][1])).not.toContain(
        'usaGestionEdificios',
      );
    });
  });

  describe('revisión final', () => {
    it('un valor guardado sin normalizar (mayúsculas): la condición evita el casteo de Mongoose con $expr', async () => {
      const { servicio, modelo } = servicioCon({
        doc: copropiedad({ comptableEmpresaId: 'A'.repeat(24) }),
      });

      await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: B,
        forzar: true,
      });

      const [filtro] = modelo.updateOne.mock.calls[0];
      expect(filtro).not.toHaveProperty('comptableEmpresaId');
      expect(filtro.$expr).toEqual({
        $eq: ['$comptableEmpresaId', 'A'.repeat(24)],
      });
    });

    it('la escritura solo alcanza copropiedades activas', async () => {
      const { servicio, modelo } = servicioCon();

      await servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A });

      expect(modelo.updateOne.mock.calls[0][0]).toMatchObject({
        estado: 'active',
      });
    });

    it('copropiedad inactivada entre la lectura y la escritura: 404', async () => {
      const { servicio } = servicioCon({
        matched: 0,
        relectura: copropiedad({ estado: 'inactive' }),
      });

      const e = await capturar(
        servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A }),
      );

      expect(e).toBeInstanceOf(NotFoundException);
    });

    it('perder la carrera contra el MISMO valor es idempotente: 200', async () => {
      const { servicio } = servicioCon({
        matched: 0,
        relectura: copropiedad({ comptableEmpresaId: A }),
      });

      const res = await servicio.fijarVinculo(ID, {
        sistema: 'comptable',
        registroId: A,
      });

      expect(res).toEqual({ sistema: 'comptable', registroId: A });
    });

    it('el valorActual del 409 por carrera sale normalizado', async () => {
      const { servicio } = servicioCon({
        matched: 0,
        relectura: copropiedad({ comptableEmpresaId: 'B'.repeat(24) }),
      });

      const e = await capturar(
        servicio.fijarVinculo(ID, { sistema: 'comptable', registroId: A }),
      );

      expect(e.getResponse()).toMatchObject({ valorActual: B });
    });
  });

  it('nunca llama a Comptable: el servicio solo depende del modelo', () => {
    expect(IntegracionesPanelService.length).toBe(1);
  });
});

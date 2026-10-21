import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { PropietariosService } from './propietarios.service';

const ID = '507f1f77bcf86cd799439011';
const COPROPIEDAD_ID = new Types.ObjectId();

/** Query-builder stub: records the chained calls and resolves to `resultado`. */
const consulta = (resultado: unknown) => {
  const llamadas: Record<string, unknown[]> = {};
  const q: Record<string, unknown> = {};
  for (const metodo of ['select', 'sort', 'limit']) {
    q[metodo] = jest.fn((...args: unknown[]) => {
      llamadas[metodo] = args;
      return q;
    });
  }
  q.lean = jest.fn(() => Promise.resolve(resultado));
  return { q, llamadas };
};

const montar = (opciones: {
  copropiedades?: unknown[];
  inmuebles?: unknown[];
  terceros?: unknown[];
}) => {
  const cop = consulta(
    opciones.copropiedades ?? [{ _id: COPROPIEDAD_ID, nombre: 'Demo' }],
  );
  const inm = consulta(opciones.inmuebles ?? []);
  const ter = consulta(opciones.terceros ?? []);
  const copropiedades = { find: jest.fn(() => cop.q), findById: jest.fn() };
  const inmuebles = { find: jest.fn(() => inm.q), findById: jest.fn() };
  const terceros = { find: jest.fn(() => ter.q), findById: jest.fn() };
  const service = new PropietariosService(
    copropiedades as never,
    inmuebles as never,
    terceros as never,
  );
  return { service, copropiedades, inmuebles, terceros, cop, inm, ter };
};

const unidades = (n: number, titularId: Types.ObjectId | null = null) =>
  Array.from({ length: n }, (_, i) => ({
    codigo: String(i + 1),
    titularId,
    tipoTitular: 'propietario' as const,
  }));

describe('PropietariosService', () => {
  describe('búsqueda de la copropiedad', () => {
    it('filtra por id y por usaGestionEdificios activo, con límite 2', async () => {
      const t = montar({});

      await t.service.obtener(ID);

      expect(t.copropiedades.find).toHaveBeenCalledWith({
        websaco3CopropiedadId: ID,
        usaGestionEdificios: true,
      });
      expect(t.cop.llamadas.limit).toEqual([2]);
    });

    it('ninguna: 404 y no lee unidades', async () => {
      const t = montar({ copropiedades: [] });

      await expect(t.service.obtener(ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(t.inmuebles.find).not.toHaveBeenCalled();
      expect(t.terceros.find).not.toHaveBeenCalled();
    });

    it('más de una: 409 y no lee unidades', async () => {
      const t = montar({
        copropiedades: [
          { _id: new Types.ObjectId(), nombre: 'A' },
          { _id: new Types.ObjectId(), nombre: 'B' },
        ],
      });

      await expect(t.service.obtener(ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(t.inmuebles.find).not.toHaveBeenCalled();
      expect(t.terceros.find).not.toHaveBeenCalled();
    });

    it('nunca usa findById sobre datos del tenant', async () => {
      const t = montar({});

      await t.service.obtener(ID);

      expect(t.copropiedades.findById).not.toHaveBeenCalled();
      expect(t.inmuebles.findById).not.toHaveBeenCalled();
      expect(t.terceros.findById).not.toHaveBeenCalled();
    });
  });

  describe('lecturas con tenant', () => {
    it('inmuebles se filtra por el _id de la copropiedad encontrada, ordenado por código', async () => {
      const t = montar({ inmuebles: unidades(1) });

      await t.service.obtener(ID);

      expect(t.inmuebles.find).toHaveBeenCalledTimes(1);
      expect(t.inmuebles.find).toHaveBeenCalledWith({
        copropiedadId: COPROPIEDAD_ID,
      });
      expect(t.inm.llamadas.sort).toEqual([{ codigo: 1 }]);
      expect(t.inm.llamadas.limit).toEqual([2001]);
    });

    it('terceros: una sola consulta con copropiedadId, ids distintos y solo activos', async () => {
      const a = new Types.ObjectId();
      const b = new Types.ObjectId();
      const t = montar({
        inmuebles: [...unidades(3, a), ...unidades(2, b), ...unidades(2, null)],
        terceros: [],
      });

      await t.service.obtener(ID);

      expect(t.terceros.find).toHaveBeenCalledTimes(1);
      const [filtro] = t.terceros.find.mock.calls[0] as unknown as [
        {
          copropiedadId: Types.ObjectId;
          _id: { $in: Types.ObjectId[] };
          estado: string;
        },
      ];
      expect(filtro.copropiedadId).toBe(COPROPIEDAD_ID);
      expect(filtro.estado).toBe('active');
      expect(filtro._id.$in.map(String).sort()).toEqual(
        [String(a), String(b)].sort(),
      );
    });

    it('sin titulares: no consulta terceros', async () => {
      const t = montar({ inmuebles: unidades(3, null) });

      await t.service.obtener(ID);

      expect(t.terceros.find).not.toHaveBeenCalled();
    });

    it('mil quinientas unidades: una consulta de inmuebles y una de terceros', async () => {
      const a = new Types.ObjectId();
      const t = montar({ inmuebles: unidades(1500, a) });

      await t.service.obtener(ID);

      expect(t.inmuebles.find).toHaveBeenCalledTimes(1);
      expect(t.terceros.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('tope de unidades', () => {
    it('2000 unidades: responde', async () => {
      const t = montar({ inmuebles: unidades(2000) });

      const res = await t.service.obtener(ID);

      expect(res.unidades).toHaveLength(2000);
    });

    it('2001 unidades: 422 demasiadas-unidades y no lee terceros', async () => {
      const t = montar({ inmuebles: unidades(2001, new Types.ObjectId()) });

      const falla = t.service.obtener(ID);

      await expect(falla).rejects.toBeInstanceOf(UnprocessableEntityException);
      await falla.catch((e: UnprocessableEntityException) => {
        expect(e.getStatus()).toBe(422);
        expect(e.getResponse()).toMatchObject({
          statusCode: 422,
          error: 'demasiadas-unidades',
        });
      });
      expect(t.terceros.find).not.toHaveBeenCalled();
    });
  });

  describe('resultado', () => {
    it('arma el contrato con el titular resuelto', async () => {
      const tid = new Types.ObjectId();
      const t = montar({
        inmuebles: [
          { codigo: '101', titularId: tid, tipoTitular: 'arrendatario' },
          { codigo: '102', titularId: null, tipoTitular: 'propietario' },
        ],
        terceros: [
          {
            _id: tid,
            nombre: 'Ana',
            emails: ['a@x.co'],
            telefono: '3001',
            estado: 'active',
          },
        ],
      });

      const res = await t.service.obtener(ID);

      expect(res).toEqual({
        copropiedad: { nombre: 'Demo' },
        unidades: [
          {
            codigo: '101',
            tipo: 'arrendatario',
            titular: {
              nombre: 'Ana',
              email: 'a@x.co',
              emails: ['a@x.co'],
              telefono: '3001',
            },
          },
          { codigo: '102', tipo: 'propietario', titular: null },
        ],
      });
    });

    it('no depende del contexto de tenant (solo tres modelos en el constructor)', () => {
      expect(PropietariosService.length).toBe(3);
    });
  });

  it('un fallo del modelo se propaga (el cliente reintenta con 5xx)', async () => {
    const t = montar({});
    (t.cop.q.lean as jest.Mock).mockRejectedValueOnce(new Error('db caída'));

    await expect(t.service.obtener(ID)).rejects.toThrow('db caída');
  });
});

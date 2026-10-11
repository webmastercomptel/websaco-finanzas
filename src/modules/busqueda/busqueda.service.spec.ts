import { Types } from 'mongoose';
import { BusquedaService } from './busqueda.service';
import { CaslAbilityFactory } from '../casl/casl-ability.factory';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const COP = new Types.ObjectId();
const tenant = () => ({ resolveCoPropertyId: () => COP }) as never;

type Fila = Record<string, unknown>;
type Regex = { $regex: string; $options: string };
type FiltroDocumento = {
  copropiedadId: Types.ObjectId;
  $or: Record<string, unknown>[];
};

/** The query-builder surface the service uses; each step returns the chain. */
interface Cadena {
  sort: jest.Mock<Cadena>;
  limit: jest.Mock<Cadena>;
  populate: jest.Mock<Cadena>;
  lean: jest.Mock<Cadena>;
  distinct: jest.Mock<Cadena>;
  exec: () => Promise<unknown>;
}

/**
 * Chainable stand-in for a Mongoose model: every query method returns the same
 * chain, `exec` resolves the canned rows (or the canned ids after
 * `.distinct()`), and `find` is a spy so the filter the service built can be
 * inspected afterwards.
 */
const modelo = (
  filas: Fila[] = [],
  distinctIds: Types.ObjectId[] = [],
  filasPorFiltro?: (filtro: Record<string, unknown>) => Fila[],
) => ({
  find: jest.fn((filtro: Record<string, unknown>, _proyeccion?: unknown) => {
    let resultado: unknown = filasPorFiltro ? filasPorFiltro(filtro) : filas;
    const cadena: Cadena = {
      sort: jest.fn(() => cadena),
      limit: jest.fn(() => cadena),
      populate: jest.fn(() => cadena),
      lean: jest.fn(() => cadena),
      distinct: jest.fn(() => {
        resultado = distinctIds;
        return cadena;
      }),
      exec: () => Promise.resolve(resultado),
    };
    return cadena;
  }),
});

const usuario = (permissions: string[], isPlatformAdmin = false) =>
  ({
    uid: 'uid-1',
    email: 'a@b.co',
    permissions,
    isPlatformAdmin,
  }) as IRequestUser;

const INM_1041 = new Types.ObjectId();
const INM_2000 = new Types.ObjectId();

const construir = (
  config: {
    facturas?: Fila[];
    recibos?: Fila[];
    notasCredito?: Fila[];
    notasDebito?: Fila[];
    notasContables?: Fila[];
    notasAnticipo?: Fila[];
    inmueblesCoincidentes?: Fila[];
    inmueblesDisplay?: Fila[];
    terceroIds?: Types.ObjectId[];
  } = {},
) => {
  const facturas = modelo(config.facturas);
  const recibos = modelo(config.recibos);
  const notasCredito = modelo(config.notasCredito);
  const notasDebito = modelo(config.notasDebito);
  const notasContables = modelo(config.notasContables);
  const notasAnticipo = modelo(config.notasAnticipo);
  const terceros = modelo([], config.terceroIds ?? []);
  // The units model answers two different queries: the id-only match (no `_id`
  // in the filter) and the display lookup (filter by `_id.$in`).
  const inmuebles = modelo([], [], (filtro) =>
    '_id' in filtro
      ? (config.inmueblesDisplay ?? [])
      : (config.inmueblesCoincidentes ?? []),
  );
  const servicio = new BusquedaService(
    facturas as never,
    recibos as never,
    notasCredito as never,
    notasDebito as never,
    notasContables as never,
    notasAnticipo as never,
    inmuebles as never,
    terceros as never,
    tenant(),
    new CaslAbilityFactory(),
  );
  return {
    servicio,
    facturas,
    recibos,
    notasCredito,
    notasDebito,
    notasContables,
    notasAnticipo,
    inmuebles,
    terceros,
  };
};

const fecha = (iso: string) => new Date(iso);

describe('BusquedaService', () => {
  describe('permisos por grupo', () => {
    it('con solo facturas.ver devuelve únicamente la clave facturas y no consulta lo demás', async () => {
      const m = construir();

      const r = await m.servicio.buscar(usuario(['facturas.ver']), {
        q: '1041',
      });

      expect(Object.keys(r)).toEqual(['facturas']);
      expect(r.facturas).toEqual([]);
      expect(m.recibos.find).not.toHaveBeenCalled();
      expect(m.notasCredito.find).not.toHaveBeenCalled();
      expect(m.notasDebito.find).not.toHaveBeenCalled();
      expect(m.notasContables.find).not.toHaveBeenCalled();
      expect(m.notasAnticipo.find).not.toHaveBeenCalled();
    });

    it('un administrador de plataforma recibe los cuatro grupos', async () => {
      const m = construir();

      const r = await m.servicio.buscar(usuario([], true), { q: '1041' });

      expect(Object.keys(r).sort()).toEqual([
        'facturas',
        'inmuebles',
        'notas',
        'recibos',
      ]);
    });

    it('cada tipo de nota se gobierna por su propio permiso (débito = otras-notas)', async () => {
      const m = construir();

      const r = await m.servicio.buscar(usuario(['otras-notas.ver']), {
        q: '1041',
      });

      expect(Object.keys(r)).toEqual(['notas']);
      expect(m.notasDebito.find).toHaveBeenCalledTimes(1);
      expect(m.notasCredito.find).not.toHaveBeenCalled();
      expect(m.notasContables.find).not.toHaveBeenCalled();
      expect(m.notasAnticipo.find).not.toHaveBeenCalled();
    });

    it('sin ningún permiso de lectura no consulta nada y devuelve {}', async () => {
      const m = construir();

      const r = await m.servicio.buscar(usuario(['facturas.crear']), {
        q: '1041',
      });

      expect(r).toEqual({});
      expect(m.terceros.find).not.toHaveBeenCalled();
      expect(m.inmuebles.find).not.toHaveBeenCalled();
    });
  });

  describe('filtro', () => {
    it('escapa la expresión regular del término buscado', async () => {
      const m = construir();

      await m.servicio.buscar(usuario([], true), { q: '1041(' });

      const filtro = m.facturas.find.mock.calls[0][0] as unknown as {
        $or: { numeroCompleto: Regex }[];
      };
      expect(filtro.$or[0].numeroCompleto).toEqual({
        $regex: '1041\\(',
        $options: 'i',
      });
      const filtroTerceros = m.terceros.find.mock.calls[0][0] as unknown as {
        nombre: Regex;
      };
      expect(filtroTerceros.nombre.$regex).toBe('1041\\(');
      const filtroInmuebles = m.inmuebles.find.mock.calls[0][0] as unknown as {
        $or: { codigo: Regex }[];
      };
      expect(filtroInmuebles.$or[0].codigo.$regex).toBe('1041\\(');
    });

    it('agrega la rama por inmuebleId cuando hay unidades coincidentes y fija el tenant como ObjectId', async () => {
      const m = construir({
        inmueblesCoincidentes: [{ _id: INM_1041 }, { _id: INM_2000 }],
      });

      await m.servicio.buscar(usuario([], true), { q: '1041' });

      for (const modeloDoc of [m.facturas, m.recibos, m.notasCredito]) {
        const filtro = modeloDoc.find.mock
          .calls[0][0] as unknown as FiltroDocumento;
        expect(filtro.copropiedadId).toBe(COP);
        expect(filtro.copropiedadId).toBeInstanceOf(Types.ObjectId);
        expect(filtro.$or).toHaveLength(2);
        expect(filtro.$or[1]).toEqual({
          inmuebleId: { $in: [INM_1041, INM_2000] },
        });
      }
    });

    it('sin unidades coincidentes solo busca por numeroCompleto', async () => {
      const m = construir();

      await m.servicio.buscar(usuario([], true), { q: '1041' });

      const filtro = m.recibos.find.mock
        .calls[0][0] as unknown as FiltroDocumento;
      expect(filtro.$or).toHaveLength(1);
      expect(filtro.$or[0]).toHaveProperty('numeroCompleto');
    });

    it('resuelve el titular por nombre de tercero dentro del tenant y lo suma a las unidades', async () => {
      const tercero = new Types.ObjectId();
      const m = construir({ terceroIds: [tercero] });

      await m.servicio.buscar(usuario(['inmuebles.ver']), { q: 'pérez' });

      const filtroTerceros = m.terceros.find.mock.calls[0][0] as unknown as {
        copropiedadId: unknown;
      };
      expect(filtroTerceros.copropiedadId).toBe(COP);
      const filtroInmuebles = m.inmuebles.find.mock
        .calls[0][0] as unknown as FiltroDocumento;
      expect(filtroInmuebles.copropiedadId).toBe(COP);
      expect(filtroInmuebles.$or).toContainEqual({
        titularId: { $in: [tercero] },
      });
    });

    it('aplica el límite pedido (5 por defecto) a cada consulta', async () => {
      const m = construir();

      await m.servicio.buscar(usuario(['facturas.ver']), { q: '1041' });
      await m.servicio.buscar(usuario(['facturas.ver']), {
        q: '1041',
        limite: 12,
      });

      const [porDefecto, pedido] = m.facturas.find.mock.results.map(
        (r) => r.value as { limit: jest.Mock },
      );
      expect(porDefecto.limit).toHaveBeenCalledWith(5);
      expect(pedido.limit).toHaveBeenCalledWith(12);
    });
  });

  describe('resultados', () => {
    it('una factura usa el código y el titular congelados, no los datos vivos de la unidad', async () => {
      const facturaId = new Types.ObjectId();
      const m = construir({
        facturas: [
          {
            _id: facturaId,
            inmuebleId: INM_1041,
            codigoInmueble: 'A-101',
            titular: { nombre: 'Titular Congelado' },
            numeroCompleto: 'FV-0010',
            fechaEmision: fecha('2026-03-05T00:00:00.000Z'),
            total: 150000,
            estado: 'anulada',
          },
        ],
        // The live unit now has another code and holder: it must be ignored.
        inmueblesCoincidentes: [{ _id: INM_1041 }],
        inmueblesDisplay: [
          {
            _id: INM_1041,
            codigo: 'Z-999',
            titularId: { _id: new Types.ObjectId(), nombre: 'Titular Vivo' },
            estado: 'active',
          },
        ],
      });

      const r = await m.servicio.buscar(usuario(['facturas.ver']), {
        q: 'FV-0010',
      });

      expect(r.facturas).toEqual([
        {
          id: facturaId.toString(),
          tipo: 'FV',
          numeroCompleto: 'FV-0010',
          fecha: '2026-03-05T00:00:00.000Z',
          inmuebleId: INM_1041.toString(),
          inmuebleCodigo: 'A-101',
          titularNombre: 'Titular Congelado',
          monto: 150000,
          estado: 'anulada',
        },
      ]);
    });

    it('un recibo muestra el código y el titular vivos de la unidad, con una sola consulta de unidades dentro del tenant', async () => {
      const reciboId = new Types.ObjectId();
      const m = construir({
        recibos: [
          {
            _id: reciboId,
            inmuebleId: INM_1041,
            numeroCompleto: 'RC-0003',
            fechaRecibo: fecha('2026-04-01T00:00:00.000Z'),
            montoRecibido: 80000,
            estado: 'activo',
          },
        ],
        inmueblesDisplay: [
          {
            _id: INM_1041,
            codigo: 'A-101',
            titularId: { _id: new Types.ObjectId(), nombre: 'Ana Gómez' },
            estado: 'active',
          },
        ],
      });

      const r = await m.servicio.buscar(usuario(['recibos.ver']), {
        q: 'RC-0003',
      });

      expect(r.recibos).toEqual([
        {
          id: reciboId.toString(),
          tipo: 'RC',
          numeroCompleto: 'RC-0003',
          fecha: '2026-04-01T00:00:00.000Z',
          inmuebleId: INM_1041.toString(),
          inmuebleCodigo: 'A-101',
          titularNombre: 'Ana Gómez',
          monto: 80000,
          estado: 'activo',
        },
      ]);
      // Match query + exactly one display lookup, scoped to the tenant.
      expect(m.inmuebles.find).toHaveBeenCalledTimes(2);
      const filtroDisplay = m.inmuebles.find.mock.calls[1][0] as unknown as {
        copropiedadId: unknown;
        _id: { $in: Types.ObjectId[] };
      };
      expect(filtroDisplay.copropiedadId).toBe(COP);
      expect(filtroDisplay._id.$in).toEqual([INM_1041]);
    });

    it('las notas se mezclan de todos los tipos, ordenadas por fecha desc, y se recortan al límite', async () => {
      const base = () => ({ inmuebleId: INM_1041, _id: new Types.ObjectId() });
      const m = construir({
        notasCredito: [
          {
            ...base(),
            numeroCompleto: 'NC-1',
            fecha: null,
            createdAt: fecha('2026-01-10T00:00:00.000Z'),
            montoTotal: 10,
            estado: 'activo',
          },
        ],
        notasDebito: [
          {
            ...base(),
            numeroCompleto: 'ND-1',
            fechaEmision: fecha('2026-03-10T00:00:00.000Z'),
            total: 20,
            estado: 'emitida',
          },
        ],
        notasContables: [
          {
            ...base(),
            numeroCompleto: 'NT-1',
            fecha: fecha('2026-02-10T00:00:00.000Z'),
            createdAt: fecha('2026-02-11T00:00:00.000Z'),
            monto: 30,
            estado: 'activo',
          },
        ],
        notasAnticipo: [
          {
            ...base(),
            numeroCompleto: 'NA-1',
            fechaEmision: fecha('2026-04-10T00:00:00.000Z'),
            montoAplicado: 40,
            estado: 'anulado',
          },
        ],
      });

      const r = await m.servicio.buscar(usuario([], true), {
        q: '1',
        limite: 3,
      });

      expect(r.notas?.map((n) => [n.tipo, n.numeroCompleto, n.monto])).toEqual([
        ['NA', 'NA-1', 40],
        ['ND', 'ND-1', 20],
        ['NT', 'NT-1', 30],
      ]);
    });

    it('una nota crédito sin fecha propia usa createdAt', async () => {
      const m = construir({
        notasCredito: [
          {
            inmuebleId: INM_1041,
            _id: new Types.ObjectId(),
            numeroCompleto: 'NC-1',
            fecha: null,
            createdAt: fecha('2026-01-10T00:00:00.000Z'),
            montoTotal: 10,
            estado: 'activo',
          },
        ],
      });

      const r = await m.servicio.buscar(usuario(['notas-credito.ver']), {
        q: 'NC',
      });

      expect(r.notas?.[0].fecha).toBe('2026-01-10T00:00:00.000Z');
    });

    it('el grupo inmuebles convierte el estado al contrato y toma el titular poblado', async () => {
      const m = construir({
        inmueblesCoincidentes: [{ _id: INM_1041 }, { _id: INM_2000 }],
        inmueblesDisplay: [
          {
            _id: INM_2000,
            codigo: 'B-200',
            titularId: null,
            estado: 'inactive',
          },
          {
            _id: INM_1041,
            codigo: 'A-101',
            titularId: { _id: new Types.ObjectId(), nombre: 'Ana Gómez' },
            estado: 'active',
          },
        ],
      });

      const r = await m.servicio.buscar(usuario(['inmuebles.ver']), {
        q: '1',
      });

      // Order follows the code-sorted match list, not the lookup's order.
      expect(r.inmuebles).toEqual([
        {
          id: INM_1041.toString(),
          codigo: 'A-101',
          titularNombre: 'Ana Gómez',
          estado: 'activo',
        },
        {
          id: INM_2000.toString(),
          codigo: 'B-200',
          titularNombre: null,
          estado: 'inactivo',
        },
      ]);
    });
  });
});

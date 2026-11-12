import { Types } from 'mongoose';
import { ResidenciaService } from './residencia.service';

type Fila = Record<string, unknown>;

/**
 * A chainable stand-in for a Mongoose query: every builder method returns the
 * same object and `exec` resolves the rows. `find` is a spy so a test can read
 * the exact filter and collation the service sent.
 */
function consulta(filas: Fila[]) {
  const cadena: Record<string, jest.Mock> = {};
  for (const metodo of ['collation', 'select', 'lean', 'sort']) {
    cadena[metodo] = jest.fn(() => cadena);
  }
  cadena.exec = jest.fn(() => Promise.resolve(filas));
  return cadena;
}

function modelo(filas: Fila[]) {
  const cadena = consulta(filas);
  const find = jest.fn((_filtro: Fila) => cadena);
  return { find, cadena };
}

const COP_A = new Types.ObjectId();
const COP_B = new Types.ObjectId();
const P1 = new Types.ObjectId();
const P2 = new Types.ObjectId();
const P_AJENA = new Types.ObjectId();

interface Piezas {
  terceros?: Fila[];
  inmuebles?: Fila[];
  copropiedades?: Fila[];
  revocaciones?: Fila[];
}

function crear(p: Piezas = {}) {
  const terceros = modelo(p.terceros ?? []);
  const inmuebles = modelo(p.inmuebles ?? []);
  const copropiedades = modelo(p.copropiedades ?? []);
  const revocaciones = modelo(p.revocaciones ?? []);
  const servicio = new ResidenciaService(
    terceros as never,
    inmuebles as never,
    copropiedades as never,
    revocaciones as never,
  );
  return { servicio, terceros, inmuebles, copropiedades, revocaciones };
}

describe('ResidenciaService.tercerosPorCorreo', () => {
  it('queries the emails_ci collation with the normalized address, active parties only', async () => {
    const { servicio, terceros } = crear({ terceros: [] });

    await servicio.tercerosPorCorreo('  ANA@Example.com ');

    expect(terceros.find).toHaveBeenCalledWith({
      emails: 'ana@example.com',
      estado: 'active',
    });
    expect(terceros.cadena.collation).toHaveBeenCalledWith({
      locale: 'en',
      strength: 2,
    });
  });

  it('keeps the parties whose stored address matches, in any case', async () => {
    const { servicio } = crear({
      terceros: [
        {
          _id: P1,
          copropiedadId: COP_A,
          emails: ['otra@example.com', 'Ana@Example.COM'],
        },
      ],
    });

    await expect(
      servicio.tercerosPorCorreo('ana@example.com'),
    ).resolves.toEqual([
      { id: P1.toString(), copropiedadId: COP_A.toString() },
    ]);
  });

  it('drops a collation false positive and a legacy padded value', async () => {
    const { servicio } = crear({
      terceros: [
        // What a strength-2 collation may return although it is another address.
        { _id: P1, copropiedadId: COP_A, emails: ['straße@example.com'] },
        // Legacy padding: not matched until the party is saved again.
        { _id: P2, copropiedadId: COP_A, emails: [' strasse@example.com '] },
      ],
    });

    await expect(
      servicio.tercerosPorCorreo('strasse@example.com'),
    ).resolves.toEqual([]);
  });

  it('answers nothing for an empty address without querying', async () => {
    const { servicio, terceros } = crear();

    await expect(servicio.tercerosPorCorreo('   ')).resolves.toEqual([]);
    expect(terceros.find).not.toHaveBeenCalled();
  });
});

describe('ResidenciaService.copropiedadesPorCorreo', () => {
  const terceroDe = (id: Types.ObjectId, copro: Types.ObjectId): Fila => ({
    _id: id,
    copropiedadId: copro,
    emails: ['ana@example.com'],
  });

  it('maps each coproperty to the parties of the address that hold a unit there', async () => {
    const { servicio } = crear({
      terceros: [terceroDe(P1, COP_A), terceroDe(P2, COP_B)],
      inmuebles: [
        {
          _id: new Types.ObjectId(),
          copropiedadId: COP_A,
          titularId: P1,
          arrendatarioId: null,
        },
        {
          _id: new Types.ObjectId(),
          copropiedadId: COP_B,
          titularId: null,
          arrendatarioId: P2,
        },
      ],
      copropiedades: [
        { _id: COP_A, modulosContratados: ['finanzas'] },
        { _id: COP_B, modulosContratados: ['administracion'] },
      ],
    });

    const mapa = await servicio.copropiedadesPorCorreo('ana@example.com');

    expect(Object.fromEntries(mapa)).toEqual({
      [COP_A.toString()]: [P1.toString()],
      [COP_B.toString()]: [P2.toString()],
    });
  });

  it('only counts ACTIVE units: the query asks for estado active', async () => {
    const { servicio, inmuebles } = crear({
      terceros: [terceroDe(P1, COP_A)],
      inmuebles: [],
    });

    await servicio.copropiedadesPorCorreo('ana@example.com');

    expect(inmuebles.find).toHaveBeenCalledTimes(1);
    const filtro = inmuebles.find.mock.calls[0][0] as {
      $or: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(filtro)).toContain('"estado":"active"');
  });

  it('drops a coproperty that is inactive (not returned by the active lookup)', async () => {
    const { servicio, copropiedades } = crear({
      terceros: [terceroDe(P1, COP_A)],
      inmuebles: [
        {
          _id: new Types.ObjectId(),
          copropiedadId: COP_A,
          titularId: P1,
          arrendatarioId: null,
        },
      ],
      copropiedades: [],
    });

    const mapa = await servicio.copropiedadesPorCorreo('ana@example.com');

    expect(mapa.size).toBe(0);
    expect(copropiedades.find).toHaveBeenCalledWith({
      _id: { $in: [COP_A] },
      estado: 'active',
    });
  });

  it('answers nothing, with no further query, when no party carries the address', async () => {
    const { servicio, inmuebles, copropiedades } = crear({ terceros: [] });

    const mapa = await servicio.copropiedadesPorCorreo('ana@example.com');

    expect(mapa.size).toBe(0);
    expect(inmuebles.find).not.toHaveBeenCalled();
    expect(copropiedades.find).not.toHaveBeenCalled();
  });

  it('SEC: ResidenciaService never crosses coproperty', async () => {
    const { servicio, inmuebles } = crear({
      terceros: [terceroDe(P1, COP_A), terceroDe(P2, COP_B)],
      inmuebles: [
        // A unit of COP_A whose titular is the party of COP_B: counts for nothing.
        {
          _id: new Types.ObjectId(),
          copropiedadId: COP_A,
          titularId: P2,
          arrendatarioId: null,
        },
        // A unit pointing at a party that is not even in the matched set.
        {
          _id: new Types.ObjectId(),
          copropiedadId: COP_B,
          titularId: P_AJENA,
          arrendatarioId: null,
        },
      ],
      copropiedades: [
        { _id: COP_A, modulosContratados: ['finanzas'] },
        { _id: COP_B, modulosContratados: ['finanzas'] },
      ],
    });

    const mapa = await servicio.copropiedadesPorCorreo('ana@example.com');

    expect(mapa.size).toBe(0);

    // Every branch of the unit query names the coproperty of the matched party.
    const filtro = inmuebles.find.mock.calls[0][0] as {
      $or: Array<{ copropiedadId: Types.ObjectId }>;
    };
    expect(filtro.$or.map((r) => r.copropiedadId.toString()).sort()).toEqual(
      [COP_A.toString(), COP_B.toString()].sort(),
    );
  });
});

describe('ResidenciaService.clavesRevocadas', () => {
  it('returns the claves with an active revocation in THAT coproperty, ignoring lifted rows and other coproperties', async () => {
    const { servicio, revocaciones } = crear({
      revocaciones: [
        { copropiedadId: COP_A, clave: 'k1', activa: true },
        { copropiedadId: COP_A, clave: 'k2', activa: false },
        { copropiedadId: COP_B, clave: 'k3', activa: true },
      ],
    });

    const claves = await servicio.clavesRevocadas(
      ['k1', 'k2', 'k3'],
      COP_A.toString(),
    );

    expect([...claves]).toEqual(['k1']);
    expect(revocaciones.find).toHaveBeenCalledWith({
      clave: { $in: ['k1', 'k2', 'k3'] },
      activa: true,
    });
  });

  it('asks nothing when there is no clave to judge', async () => {
    const { servicio, revocaciones } = crear();

    await expect(
      servicio.clavesRevocadas([], COP_A.toString()),
    ).resolves.toEqual(new Set());
    expect(revocaciones.find).not.toHaveBeenCalled();
  });
});

describe('ResidenciaService.revocacionesActivas', () => {
  it('returns the coproperties with an active revocation, ignoring lifted rows', async () => {
    const { servicio, revocaciones } = crear({
      revocaciones: [
        { copropiedadId: COP_A, clave: 'k', activa: true },
        { copropiedadId: COP_B, clave: 'k', activa: false },
      ],
    });

    const revocadas = await servicio.revocacionesActivas('k', [
      COP_A.toString(),
      COP_B.toString(),
    ]);

    expect([...revocadas]).toEqual([COP_A.toString()]);
    expect(revocaciones.find).toHaveBeenCalledWith({
      clave: 'k',
      activa: true,
    });
  });

  it('does not report a revocation of a coproperty that was not asked about', async () => {
    const { servicio } = crear({
      revocaciones: [{ copropiedadId: COP_B, clave: 'k', activa: true }],
    });

    const revocadas = await servicio.revocacionesActivas('k', [
      COP_A.toString(),
    ]);

    expect(revocadas.size).toBe(0);
  });

  it('asks nothing when there is no coproperty to judge', async () => {
    const { servicio, revocaciones } = crear();

    await expect(servicio.revocacionesActivas('k', [])).resolves.toEqual(
      new Set(),
    );
    expect(revocaciones.find).not.toHaveBeenCalled();
  });
});

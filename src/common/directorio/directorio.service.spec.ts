import { Types } from 'mongoose';
import type {
  AccesoCopropiedad,
  AccesoService,
} from '../acceso/acceso.service';
import { DirectorioService } from './directorio.service';

const oid = () => new Types.ObjectId();
const COP = oid();
const ENTIDAD = oid();

type Fila = Record<string, unknown>;

/** Stub of a query chain; every call in the service ends in `.lean().exec()`. */
const consulta = (filas: Fila[]) => {
  const lean = jest
    .fn()
    .mockReturnValue({ exec: () => Promise.resolve(filas) });
  const find = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({ lean }),
    lean,
  });
  const findOne = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({ lean }),
  });
  const findById = jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: () => Promise.resolve(filas[0] ?? null),
      }),
    }),
  });
  return { find, findOne, findById };
};

const cuenta = (
  id: Types.ObjectId,
  nombreCompleto: string,
  extra: Fila = {},
) => ({
  _id: id,
  email: `${nombreCompleto.toLowerCase()}@ejemplo.com`,
  nombreCompleto,
  esAdministradorPlataforma: false,
  ...extra,
});

function acceso(permissions: string[], esResidente = false): AccesoCopropiedad {
  return {
    copropiedadId: COP.toString(),
    codigo: 'C-1',
    nombre: 'Edificio',
    permissions,
    modulos: ['finanzas', 'administracion'],
    esResidente,
  };
}

function crear(opciones: {
  cuentas?: Fila[];
  asignaciones?: Fila[];
  terceros?: Fila[];
  copropiedad?: Fila;
  accesos?: Record<string, AccesoCopropiedad | null>;
}) {
  const cuentas = consulta(opciones.cuentas ?? []);
  const asignaciones = consulta(opciones.asignaciones ?? []);
  const terceros = consulta(opciones.terceros ?? []);
  const copropiedades = consulta(
    opciones.copropiedad ? [opciones.copropiedad] : [{ entidadId: null }],
  );
  const accesoA = jest.fn((accountId: string) =>
    Promise.resolve(opciones.accesos?.[accountId] ?? null),
  );
  const servicio = new DirectorioService(
    cuentas as never,
    asignaciones as never,
    terceros as never,
    copropiedades as never,
    { accesoA } as unknown as AccesoService,
  );
  return { servicio, cuentas, asignaciones, terceros, accesoA };
}

describe('DirectorioService.residentes', () => {
  it('devuelve las cuentas activas vinculadas a un tercero activo de ESA copropiedad', async () => {
    const ana = oid();
    const { servicio, terceros, cuentas } = crear({
      terceros: [{ accountId: ana }, { accountId: ana }],
      cuentas: [cuenta(ana, 'Ana')],
    });

    const resultado = await servicio.residentes(COP);

    expect(terceros.find).toHaveBeenCalledWith({
      copropiedadId: COP,
      estado: 'active',
      accountId: { $ne: null },
    });
    expect(cuentas.find).toHaveBeenCalledWith({
      _id: { $in: [ana] },
      estado: 'active',
    });
    expect(resultado).toEqual([
      {
        accountId: ana.toString(),
        email: 'ana@ejemplo.com',
        nombre: 'Ana',
        perfil: 'residente',
      },
    ]);
  });

  it('sin terceros vinculados no consulta cuentas', async () => {
    const { servicio, cuentas } = crear({ terceros: [] });

    await expect(servicio.residentes(COP)).resolves.toEqual([]);
    expect(cuentas.find).not.toHaveBeenCalled();
  });
});

describe('DirectorioService.personalQueLeer', () => {
  it('toma asignaciones de la copropiedad Y de su entidad administradora', async () => {
    const { servicio, asignaciones } = crear({
      copropiedad: { entidadId: ENTIDAD },
      asignaciones: [],
    });

    await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(asignaciones.find).toHaveBeenCalledWith({
      estado: 'active',
      $or: [
        { alcance: 'copropiedad', copropiedadId: COP },
        { alcance: 'entidad', entidadId: ENTIDAD },
      ],
    });
  });

  it('sin entidad solo considera las asignaciones de la copropiedad', async () => {
    const { servicio, asignaciones } = crear({ asignaciones: [] });

    await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(asignaciones.find).toHaveBeenCalledWith({
      estado: 'active',
      $or: [{ alcance: 'copropiedad', copropiedadId: COP }],
    });
  });

  it('incluye solo a quien puede leer la materia con sus permisos efectivos', async () => {
    const puede = oid();
    const noPuede = oid();
    const { servicio } = crear({
      asignaciones: [{ accountId: puede }, { accountId: noPuede }],
      cuentas: [cuenta(puede, 'Luis'), cuenta(noPuede, 'Eva')],
      accesos: {
        [puede.toString()]: acceso(['tareas.ver']),
        [noPuede.toString()]: acceso(['pqr.ver']),
      },
    });

    const resultado = await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(resultado.map((d) => d.nombre)).toEqual(['Luis']);
    expect(resultado[0].perfil).toBe('personal');
  });

  it('un administrador de plataforma con asignación cuenta siempre', async () => {
    const root = oid();
    const { servicio } = crear({
      asignaciones: [{ accountId: root }],
      cuentas: [cuenta(root, 'Root', { esAdministradorPlataforma: true })],
      accesos: { [root.toString()]: acceso([]) },
    });

    const resultado = await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(resultado.map((d) => d.nombre)).toEqual(['Root']);
  });

  it('no repite a quien tiene varias asignaciones y omite al que perdió el acceso', async () => {
    const dos = oid();
    const sinAcceso = oid();
    const { servicio, accesoA } = crear({
      asignaciones: [
        { accountId: dos },
        { accountId: dos },
        { accountId: sinAcceso },
      ],
      cuentas: [cuenta(dos, 'Dos'), cuenta(sinAcceso, 'Nadie')],
      accesos: {
        [dos.toString()]: acceso(['tareas.gestionar']),
        [sinAcceso.toString()]: null,
      },
    });

    const resultado = await servicio.personalQuePuedeLeer(COP, 'Tarea');

    expect(resultado.map((d) => d.nombre)).toEqual(['Dos']);
    expect(accesoA).toHaveBeenCalledTimes(2);
  });
});

describe('DirectorioService.destinatarioPorEmail', () => {
  const id = oid();

  it('busca la cuenta por correo en minúsculas y la trata como destinatario puntual', async () => {
    const { servicio, cuentas } = crear({
      cuentas: [cuenta(id, 'Mara')],
      accesos: { [id.toString()]: acceso(['mantenimientos.ver']) },
    });

    const resultado = await servicio.destinatarioPorEmail(
      ' MARA@Ejemplo.com ',
      COP,
      'Mantenimiento',
    );

    expect(cuentas.find).toHaveBeenCalledWith({ email: 'mara@ejemplo.com' });
    expect(resultado).toMatchObject({ perfil: 'personal', nombre: 'Mara' });
  });

  it('null cuando no existe una cuenta con ese correo, sin consultar accesos', async () => {
    const { servicio, accesoA } = crear({ cuentas: [] });

    await expect(
      servicio.destinatarioPorEmail('nadie@ejemplo.com', COP, 'Mantenimiento'),
    ).resolves.toBeNull();
    expect(accesoA).not.toHaveBeenCalled();
  });
});

describe('DirectorioService.destinatarioDe', () => {
  const id = oid();
  const cuentaActiva = [cuenta(id, 'Mara')];

  it('personal cuando sus permisos le dejan leer la materia', async () => {
    const { servicio } = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: acceso(['pqr.gestionar']) },
    });

    await expect(
      servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toMatchObject({ perfil: 'personal', nombre: 'Mara' });
  });

  it('residente cuando solo es titular o arrendatario (sin permisos)', async () => {
    const { servicio } = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: acceso([], true) },
    });

    await expect(
      servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toMatchObject({ perfil: 'residente' });
  });

  it('quien es personal y residente a la vez se trata como personal', async () => {
    const { servicio } = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: acceso(['pqr.ver'], true) },
    });

    await expect(
      servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toMatchObject({ perfil: 'personal' });
  });

  it('null sin acceso a la copropiedad, o con permisos que no alcanzan y sin ser residente', async () => {
    const sinAcceso = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: null },
    });
    const sinPermiso = crear({
      cuentas: cuentaActiva,
      accesos: { [id.toString()]: acceso(['tareas.ver']) },
    });

    await expect(
      sinAcceso.servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toBeNull();
    await expect(
      sinPermiso.servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toBeNull();
  });

  it('null para una cuenta inactiva o inexistente', async () => {
    const { servicio } = crear({
      cuentas: [],
      accesos: { [id.toString()]: acceso(['pqr.ver']) },
    });

    await expect(
      servicio.destinatarioDe(id.toString(), COP, 'Pqr'),
    ).resolves.toBeNull();
  });
});

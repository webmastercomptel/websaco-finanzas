import { Types } from 'mongoose';
import { AuthController } from './auth.controller';
import { AccesoService as AccesoServiceReal } from '../../common/acceso/acceso.service';
import type {
  AccesoService,
  AccesoCopropiedad,
} from '../../common/acceso/acceso.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const accesoQueDevuelve = (
  copropiedades: AccesoCopropiedad[],
  alcance: 'copropiedad' | 'entidad' | null = null,
) => {
  const copropiedadesDe = jest.fn().mockResolvedValue(copropiedades);
  const alcancePrimarioDe = jest.fn().mockResolvedValue(alcance);
  return {
    servicio: {
      copropiedadesDe,
      alcancePrimarioDe,
    } as unknown as AccesoService,
    copropiedadesDe,
    alcancePrimarioDe,
  };
};

const user = (over: Partial<IRequestUser> = {}): IRequestUser => ({
  uid: 'uid-123',
  email: 'santiago@comptel.com',
  ...over,
});

describe('AuthController.me', () => {
  it('devuelve la identidad del llamante', async () => {
    const { servicio } = accesoQueDevuelve([]);
    const controller = new AuthController(servicio);

    await expect(
      controller.me(user({ nombre: 'Santiago', accountId: 'acc-1' })),
    ).resolves.toMatchObject({
      uid: 'uid-123',
      email: 'santiago@comptel.com',
      nombre: 'Santiago',
      esAdministradorPlataforma: false,
    });
  });

  it('devuelve nombre null cuando no hay uno', async () => {
    // El contrato promete `string | null`, no `undefined`: un campo ausente y
    // uno vacío se serializan distinto y el cliente tendría que distinguirlos.
    const { servicio } = accesoQueDevuelve([]);
    const controller = new AuthController(servicio);

    await expect(controller.me(user())).resolves.toMatchObject({
      nombre: null,
    });
  });

  it('lista las copropiedades que puede operar', async () => {
    const { servicio } = accesoQueDevuelve([
      {
        copropiedadId: 'cop-1',
        codigo: 'COP-001',
        nombre: 'Terrazas de Granada',
        permissions: ['facturas.ver'],
        modulos: ['finanzas', 'administracion'],
        esResidente: false,
      },
    ]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(user({ accountId: 'acc-1' }));

    expect(resultado.copropiedades).toEqual([
      {
        id: 'cop-1',
        codigo: 'COP-001',
        nombre: 'Terrazas de Granada',
        modulos: ['finanzas', 'administracion'],
        esResidente: false,
        permisos: ['facturas.ver'],
      },
    ]);
  });

  it('auth/me incluye los permisos efectivos de cada copropiedad', async () => {
    // El menú del cliente se filtra con esto. Es una cortesía de la interfaz:
    // el servidor revalida cada petición, así que exponerlo no da acceso.
    const { servicio } = accesoQueDevuelve([
      {
        copropiedadId: 'cop-1',
        codigo: 'COP-001',
        nombre: 'Terrazas',
        permissions: ['facturas.anular', 'tareas.gestionar'],
        modulos: ['finanzas', 'administracion'],
        esResidente: false,
      },
      {
        copropiedadId: 'cop-2',
        codigo: 'COP-002',
        nombre: 'Bosques',
        permissions: ['pqr.ver'],
        modulos: ['administracion'],
        esResidente: false,
      },
    ]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(user({ accountId: 'acc-1' }));

    expect(resultado.copropiedades.map((c) => c.permisos)).toEqual([
      ['facturas.anular', 'tareas.gestionar'],
      ['pqr.ver'],
    ]);
  });

  it('auth/me de un residente trae permisos vacíos', async () => {
    const { servicio } = accesoQueDevuelve([
      {
        copropiedadId: 'cop-1',
        codigo: 'COP-001',
        nombre: 'Terrazas',
        permissions: [],
        modulos: ['finanzas', 'administracion'],
        esResidente: true,
      },
    ]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(user({ accountId: 'acc-1' }));

    expect(resultado.copropiedades[0]).toMatchObject({
      esResidente: true,
      permisos: [],
    });
  });

  it('el administrador de plataforma recibe permisos vacíos: su bandera ya alcanza', async () => {
    const { servicio } = accesoQueDevuelve([
      {
        copropiedadId: 'cop-1',
        codigo: 'COP-001',
        nombre: 'Terrazas',
        permissions: [],
        modulos: ['finanzas'],
        esResidente: false,
      },
    ]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(
      user({ accountId: 'acc-1', isPlatformAdmin: true }),
    );

    expect(resultado.esAdministradorPlataforma).toBe(true);
    expect(resultado.copropiedades[0].permisos).toEqual([]);
  });

  it('personal nunca ve claves de finanzas en auth/me', async () => {
    // Con el AccesoService real: el techo del perfil `personal` quita las
    // claves de Finanzas guardadas, y lo que sale por auth/me es lo ya
    // recortado, no lo almacenado.
    const copId = new Types.ObjectId();
    const filas = (rows: Array<Record<string, unknown>>) => ({
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: () => Promise.resolve(rows[0] ?? null),
          }),
        }),
      }),
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          sort: jest.fn().mockReturnValue({
            lean: jest.fn().mockReturnValue({
              exec: () => Promise.resolve(rows),
            }),
          }),
          lean: jest.fn().mockReturnValue({
            exec: () => Promise.resolve(rows),
          }),
        }),
        lean: jest.fn().mockReturnValue({
          exec: () => Promise.resolve(rows),
        }),
      }),
    });
    const acceso = new AccesoServiceReal(
      filas([
        {
          alcance: 'copropiedad',
          copropiedadId: copId,
          perfil: 'personal',
          permisos: ['facturas.ver', 'tareas.ver', 'pqr.ver'],
        },
      ]) as never,
      filas([
        {
          _id: copId,
          codigo: 'COP-A',
          nombre: 'Edificio A',
          modulosContratados: ['finanzas', 'administracion'],
        },
      ]) as never,
      filas([]) as never,
      filas([]) as never,
      filas([]) as never,
      filas([]) as never,
    );
    const controller = new AuthController(acceso);

    const resultado = await controller.me(
      user({ accountId: new Types.ObjectId().toString() }),
    );

    const permisos = resultado.copropiedades[0].permisos;
    expect(permisos).toEqual(expect.arrayContaining(['tareas.ver', 'pqr.ver']));
    expect(permisos).not.toContain('facturas.ver');
  });

  it('sin cuenta local no consulta asignaciones', async () => {
    // No hay nada que buscar: sería una consulta cuya respuesta ya se conoce.
    const { servicio, copropiedadesDe } = accesoQueDevuelve([]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(user({ accountId: undefined }));

    expect(copropiedadesDe).not.toHaveBeenCalled();
    expect(resultado.copropiedades).toEqual([]);
  });

  it('propaga la condición de administrador de plataforma al servicio', async () => {
    const { servicio, copropiedadesDe } = accesoQueDevuelve([]);
    const controller = new AuthController(servicio);

    await controller.me(user({ accountId: 'acc-1', isPlatformAdmin: true }));

    expect(copropiedadesDe).toHaveBeenCalledWith('acc-1', true);
  });

  it('devuelve el alcance de la asignación primaria de una cuenta normal', async () => {
    const { servicio } = accesoQueDevuelve([], 'copropiedad');
    const controller = new AuthController(servicio);

    const resultado = await controller.me(user({ accountId: 'acc-1' }));

    expect(resultado.alcance).toBe('copropiedad');
  });

  it('no consulta el alcance para un administrador de plataforma: su propia bandera ya alcanza', async () => {
    const { servicio, alcancePrimarioDe } = accesoQueDevuelve([]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(
      user({ accountId: 'acc-1', isPlatformAdmin: true }),
    );

    expect(alcancePrimarioDe).not.toHaveBeenCalled();
    expect(resultado.alcance).toBeNull();
  });

  it('sin cuenta local, el alcance es null', async () => {
    const { servicio, alcancePrimarioDe } = accesoQueDevuelve([]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(user({ accountId: undefined }));

    expect(alcancePrimarioDe).not.toHaveBeenCalled();
    expect(resultado.alcance).toBeNull();
  });
});

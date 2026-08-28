import { AuthController } from './auth.controller';
import type {
  AccesoService,
  AccesoCopropiedad,
} from '../../common/acceso/acceso.service';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';

const accesoQueDevuelve = (copropiedades: AccesoCopropiedad[]) => {
  const copropiedadesDe = jest.fn().mockResolvedValue(copropiedades);
  return {
    servicio: { copropiedadesDe } as unknown as AccesoService,
    copropiedadesDe,
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
        coPropertyId: 'cop-1',
        codigo: 'COP-001',
        nombre: 'Terrazas de Granada',
        permissions: ['facturas.ver'],
      },
    ]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(user({ accountId: 'acc-1' }));

    expect(resultado.copropiedades).toEqual([
      { id: 'cop-1', codigo: 'COP-001', nombre: 'Terrazas de Granada' },
    ]);
  });

  it('no filtra los permisos en la respuesta', async () => {
    // El selector solo necesita reconocer y elegir. Los permisos se aplican en
    // el servidor en cada petición; mandarlos acá invita a que el cliente los
    // use para decidir, y esa decisión no es suya.
    const { servicio } = accesoQueDevuelve([
      {
        coPropertyId: 'cop-1',
        codigo: 'COP-001',
        nombre: 'Terrazas',
        permissions: ['facturas.anular'],
      },
    ]);
    const controller = new AuthController(servicio);

    const resultado = await controller.me(user({ accountId: 'acc-1' }));

    expect(JSON.stringify(resultado)).not.toContain('facturas.anular');
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
});

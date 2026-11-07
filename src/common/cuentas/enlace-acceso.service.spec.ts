import { createHash } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type {
  AccesoCopropiedad,
  AccesoService,
} from '../acceso/acceso.service';
import { EnlaceAccesoService } from './enlace-acceso.service';

const CUENTA_ID = new Types.ObjectId();
const COPROPIEDAD_ID = new Types.ObjectId();

const hash = (token: string) =>
  createHash('sha256').update(token).digest('hex');

function acceso(permissions: string[]): AccesoCopropiedad {
  return {
    copropiedadId: COPROPIEDAD_ID.toString(),
    codigo: 'C-1',
    nombre: 'Edificio',
    permissions,
    modulos: ['finanzas', 'administracion'],
    esResidente: permissions.length === 0,
  };
}

interface Opciones {
  cuenta?: Record<string, unknown> | null;
  acceso?: AccesoCopropiedad | null;
  enlace?: Record<string, unknown> | null;
  frontendUrl?: string | undefined;
}

function crear(opciones: Opciones = {}) {
  const cuenta =
    opciones.cuenta === undefined
      ? {
          _id: CUENTA_ID,
          firebaseUid: 'uid-1',
          estado: 'active',
          esAdministradorPlataforma: false,
        }
      : opciones.cuenta;
  const accesoResuelto =
    opciones.acceso === undefined ? acceso([]) : opciones.acceso;

  const crearEnlace = jest.fn().mockResolvedValue({});
  const enlaces = {
    create: crearEnlace,
    findOne: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(opciones.enlace ?? null),
    }),
  };
  const cuentas = {
    findById: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(cuenta),
    }),
  };
  const accesoService = {
    accesoA: jest.fn().mockResolvedValue(accesoResuelto),
  };
  const auth = {
    createCustomToken: jest.fn().mockResolvedValue('custom-token'),
  };
  const config = {
    get: (clave: string) =>
      clave === 'app.frontendUrl'
        ? 'frontendUrl' in opciones
          ? opciones.frontendUrl
          : 'https://app.ejemplo.com'
        : undefined,
  } as unknown as ConfigService;

  const servicio = new EnlaceAccesoService(
    config,
    enlaces as never,
    cuentas as never,
    accesoService as unknown as AccesoService,
    auth as never,
  );
  return { servicio, crearEnlace, enlaces, accesoService, auth };
}

describe('EnlaceAccesoService.construir', () => {
  it('devuelve una URL /auth/enlace con el token y guarda solo su hash', async () => {
    const { servicio, crearEnlace } = crear();

    const url = await servicio.construir(
      CUENTA_ID.toString(),
      COPROPIEDAD_ID.toString(),
      '/mantenimientos?abrir=1',
    );

    const direccion = new URL(url!);
    expect(direccion.origin).toBe('https://app.ejemplo.com');
    expect(direccion.pathname).toBe('/auth/enlace');
    const token = direccion.searchParams.get('token')!;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const [guardado] = crearEnlace.mock.calls[0] as [Record<string, unknown>];
    expect(guardado.tokenHash).toBe(hash(token));
    expect(JSON.stringify(guardado)).not.toContain(token);
    expect(guardado.destino).toBe('/mantenimientos?abrir=1');
    expect((guardado.expiraEn as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it.each(['https://malo.com', '//malo.com', 'mantenimientos', '/\\malo.com'])(
    'rechaza un destino que no es una ruta propia (%s)',
    async (destino) => {
      const { servicio, crearEnlace } = crear();

      await expect(
        servicio.construir(
          CUENTA_ID.toString(),
          COPROPIEDAD_ID.toString(),
          destino,
        ),
      ).resolves.toBeNull();
      expect(crearEnlace).not.toHaveBeenCalled();
    },
  );

  it('devuelve null sin FRONTEND_URL, para que el correo use un enlace común', async () => {
    const { servicio, crearEnlace } = crear({ frontendUrl: undefined });

    await expect(
      servicio.construir(CUENTA_ID.toString(), COPROPIEDAD_ID.toString(), '/'),
    ).resolves.toBeNull();
    expect(crearEnlace).not.toHaveBeenCalled();
  });

  it.each([
    ['una cuenta con permisos financieros', acceso(['facturas.ver'])],
    ['una cuenta sin acceso a la copropiedad', null],
  ])('no emite enlace para %s', async (_nombre, accesoDeCuenta) => {
    const { servicio, crearEnlace } = crear({ acceso: accesoDeCuenta });

    await expect(
      servicio.construir(CUENTA_ID.toString(), COPROPIEDAD_ID.toString(), '/'),
    ).resolves.toBeNull();
    expect(crearEnlace).not.toHaveBeenCalled();
  });

  it('emite enlace al personal que solo tiene permisos de Administración', async () => {
    const { servicio } = crear({ acceso: acceso(['tareas.ver', 'pqr.ver']) });

    await expect(
      servicio.construir(CUENTA_ID.toString(), COPROPIEDAD_ID.toString(), '/'),
    ).resolves.toEqual(expect.stringContaining('/auth/enlace?token='));
  });

  it.each([
    ['inactiva', { estado: 'inactive', esAdministradorPlataforma: false }],
    [
      'de administrador de plataforma',
      { estado: 'active', esAdministradorPlataforma: true },
    ],
    ['inexistente', null],
  ])('no emite enlace para una cuenta %s', async (_nombre, cuenta) => {
    const { servicio, crearEnlace } = crear({
      cuenta: cuenta && { _id: CUENTA_ID, firebaseUid: 'u', ...cuenta },
    });

    await expect(
      servicio.construir(CUENTA_ID.toString(), COPROPIEDAD_ID.toString(), '/'),
    ).resolves.toBeNull();
    expect(crearEnlace).not.toHaveBeenCalled();
  });
});

describe('EnlaceAccesoService.canjear', () => {
  const enlaceVigente = {
    accountId: CUENTA_ID,
    copropiedadId: COPROPIEDAD_ID,
    destino: '/pqr',
  };

  it('busca por hash y vigencia, y devuelve un token personalizado del uid de la cuenta', async () => {
    const { servicio, enlaces, auth } = crear({ enlace: enlaceVigente });

    const resultado = await servicio.canjear('abc');

    const cualquierFecha: unknown = expect.any(Date);
    expect(enlaces.findOne).toHaveBeenCalledWith({
      tokenHash: hash('abc'),
      expiraEn: { $gt: cualquierFecha },
    });
    expect(auth.createCustomToken).toHaveBeenCalledWith('uid-1');
    expect(resultado).toEqual({
      customToken: 'custom-token',
      copropiedadId: COPROPIEDAD_ID.toString(),
      destino: '/pqr',
    });
  });

  it('devuelve null para un token desconocido o vencido', async () => {
    const { servicio, auth } = crear({ enlace: null });

    await expect(servicio.canjear('abc')).resolves.toBeNull();
    expect(auth.createCustomToken).not.toHaveBeenCalled();
  });

  it('revalida al canjear: si la cuenta ganó permisos financieros después, el enlace ya no sirve', async () => {
    const { servicio, auth } = crear({
      enlace: enlaceVigente,
      acceso: acceso(['recibos.ver']),
    });

    await expect(servicio.canjear('abc')).resolves.toBeNull();
    expect(auth.createCustomToken).not.toHaveBeenCalled();
  });

  it('nunca lanza: un fallo de Firebase devuelve null', async () => {
    const { servicio, auth } = crear({ enlace: enlaceVigente });
    auth.createCustomToken.mockRejectedValue(new Error('boom'));

    await expect(servicio.canjear('abc')).resolves.toBeNull();
  });
});

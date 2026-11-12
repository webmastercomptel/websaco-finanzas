import { UnauthorizedException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { CuentaService } from './cuenta.service';

const CUENTA_ID = new Types.ObjectId();
const EMAIL = 'persona@example.com';

interface Cuenta {
  _id: Types.ObjectId;
  firebaseUid: string;
  email: string;
}

/**
 * A minimal in-memory stand-in for the Account model: enough to observe
 * whether the stored binding changed, which is the whole point of these tests.
 */
function crear(
  cuenta: Cuenta | null,
  /** Runs between the service's read and its conditional write (a race). */
  antesDeEscribir?: (almacen: Cuenta) => void,
) {
  const almacen = cuenta ? { ...cuenta } : null;

  const findOne = jest.fn((filtro: Record<string, unknown>) => ({
    exec: jest
      .fn()
      .mockResolvedValue(
        almacen &&
          Object.entries(filtro).every(
            ([campo, valor]) => almacen[campo as keyof Cuenta] === valor,
          )
          ? { ...almacen }
          : null,
      ),
  }));

  const findOneAndUpdate = jest.fn(
    (filtro: Record<string, unknown>, cambio: { $set: Partial<Cuenta> }) => ({
      exec: jest.fn().mockImplementation(() => {
        if (almacen) antesDeEscribir?.(almacen);
        const coincide =
          almacen &&
          Object.entries(filtro).every(
            ([campo, valor]) => almacen[campo as keyof Cuenta] === valor,
          );
        if (!coincide) return Promise.resolve(null);
        Object.assign(almacen, cambio.$set);
        return Promise.resolve({ ...almacen });
      }),
    }),
  );

  const servicio = new CuentaService({
    findOne,
    findOneAndUpdate,
  } as never);
  return { servicio, almacen, findOneAndUpdate };
}

describe('CuentaService.resolverPorToken', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the account bound to the same uid', async () => {
    const { servicio, findOneAndUpdate } = crear({
      _id: CUENTA_ID,
      firebaseUid: 'uid-1',
      email: EMAIL,
    });

    const cuenta = await servicio.resolverPorToken('uid-1', EMAIL);

    expect(cuenta?._id).toEqual(CUENTA_ID);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('binds an unclaimed (pendiente:) account to the first identity with its e-mail', async () => {
    const { servicio, almacen } = crear({
      _id: CUENTA_ID,
      firebaseUid: `pendiente:${EMAIL}`,
      email: EMAIL,
    });

    const cuenta = await servicio.resolverPorToken(
      'uid-nuevo',
      ' Persona@Example.com ',
    );

    expect(cuenta?._id).toEqual(CUENTA_ID);
    expect(cuenta?.firebaseUid).toBe('uid-nuevo');
    expect(almacen?.firebaseUid).toBe('uid-nuevo');
  });

  it('claims with a compare-and-set on the exact placeholder of the normalized e-mail', async () => {
    const { servicio, findOneAndUpdate } = crear({
      _id: CUENTA_ID,
      firebaseUid: `pendiente:${EMAIL}`,
      email: EMAIL,
    });

    await servicio.resolverPorToken('uid-nuevo', ' Persona@Example.com ');

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(findOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: CUENTA_ID,
      firebaseUid: `pendiente:${EMAIL}`,
    });
  });

  it('does not let a pendiente: value of another address be claimed', async () => {
    const { servicio, almacen, findOneAndUpdate } = crear({
      _id: CUENTA_ID,
      firebaseUid: 'pendiente:otra@example.com',
      email: EMAIL,
    });

    await expect(
      servicio.resolverPorToken('uid-intruso', EMAIL),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(almacen?.firebaseUid).toBe('pendiente:otra@example.com');
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('SEC: resolverPorToken never rebinds a bound account by email (a different uid carrying the address is refused and the binding stays)', async () => {
    const { servicio, almacen, findOneAndUpdate } = crear({
      _id: CUENTA_ID,
      firebaseUid: 'uid-legitimo',
      email: EMAIL,
    });

    await expect(
      servicio.resolverPorToken('uid-intruso', EMAIL),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(almacen?.firebaseUid).toBe('uid-legitimo');
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('logs the refusal by account id, never by e-mail', async () => {
    const { servicio } = crear({
      _id: CUENTA_ID,
      firebaseUid: 'uid-legitimo',
      email: EMAIL,
    });

    await expect(
      servicio.resolverPorToken('uid-intruso', EMAIL),
    ).rejects.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
    const mensaje = String(warn.mock.calls[0][0]);
    expect(mensaje).toContain(CUENTA_ID.toString());
    expect(mensaje).not.toContain(EMAIL);
  });

  it('SEC: first-claim log carries no address', async () => {
    const { servicio } = crear({
      _id: CUENTA_ID,
      firebaseUid: `pendiente:${EMAIL}`,
      email: EMAIL,
    });

    await servicio.resolverPorToken('uid-nuevo', ' Persona@Example.com ');

    expect(log).toHaveBeenCalledTimes(1);
    const mensaje = String(log.mock.calls[0][0]);
    expect(mensaje).toContain(CUENTA_ID.toString());
    expect(mensaje.toLowerCase()).not.toContain('persona@example.com');
    expect(mensaje).not.toContain('uid-nuevo');
  });

  it('SEC: two simultaneous claims of a pendiente: account bind exactly one identity', async () => {
    const { servicio, almacen } = crear({
      _id: CUENTA_ID,
      firebaseUid: `pendiente:${EMAIL}`,
      email: EMAIL,
    });

    const resultados = await Promise.allSettled([
      servicio.resolverPorToken('uid-a', EMAIL),
      servicio.resolverPorToken('uid-b', EMAIL),
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(resultados.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(['uid-a', 'uid-b']).toContain(almacen?.firebaseUid);
  });

  it('refuses the claim when another identity bound the account first (lost race)', async () => {
    // Between the read and the conditional write, somebody else claims it.
    const { servicio, almacen } = crear(
      {
        _id: CUENTA_ID,
        firebaseUid: `pendiente:${EMAIL}`,
        email: EMAIL,
      },
      (a) => {
        a.firebaseUid = 'uid-primero';
      },
    );

    await expect(
      servicio.resolverPorToken('uid-segundo', EMAIL),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(almacen?.firebaseUid).toBe('uid-primero');
  });

  it('returns null when neither uid nor e-mail match an account', async () => {
    const { servicio } = crear(null);

    await expect(servicio.resolverPorToken('uid-1', EMAIL)).resolves.toBeNull();
  });

  it('returns null for an unknown uid with no e-mail in the token', async () => {
    const { servicio } = crear({
      _id: CUENTA_ID,
      firebaseUid: 'uid-1',
      email: EMAIL,
    });

    await expect(servicio.resolverPorToken('uid-2', '')).resolves.toBeNull();
  });
});

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
function crear(cuenta: Cuenta | null) {
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

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
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

  it('refuses a different uid carrying the e-mail of an already bound account, and leaves the binding alone', async () => {
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

  it('refuses the claim when another identity bound the account first (lost race)', async () => {
    const { servicio, almacen, findOneAndUpdate } = crear({
      _id: CUENTA_ID,
      firebaseUid: `pendiente:${EMAIL}`,
      email: EMAIL,
    });
    // Between the read and the conditional write, somebody else claims it.
    findOneAndUpdate.mockImplementationOnce(() => ({
      exec: jest.fn().mockImplementation(() => {
        if (almacen) almacen.firebaseUid = 'uid-primero';
        return Promise.resolve(null);
      }),
    }));

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

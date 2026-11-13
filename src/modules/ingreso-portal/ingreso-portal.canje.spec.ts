import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { ColeccionMemoria } from '../envio-facturas/testing/coleccion-memoria';
import {
  CLAVE,
  COPRO_A,
  COPRO_B,
  CORREO,
  CUENTA_ID,
  cuentaDePrueba,
  montar,
  TOKEN,
} from './testing/montar-servicio';

const SOLO_ADMINISTRACION = [
  { copropiedadId: COPRO_A, permissions: ['pqr.ver', 'tareas.ver'] },
];
const CON_FINANZAS = [
  { copropiedadId: COPRO_A, permissions: ['tareas.ver'] },
  { copropiedadId: COPRO_B, permissions: ['facturas.ver'] },
];

describe('IngresoPortalService.canjear - consume and eligibility', () => {
  it('consumes the token BEFORE any other effect', async () => {
    const m = montar({ cuenta: {}, accesos: [] });

    await m.servicio.canjear(TOKEN);

    expect(m.eventos[0]).toBe('consumir');
    expect(m.enlaces.consumir).toHaveBeenCalledWith(TOKEN);
    expect(m.eventos.indexOf('consumir')).toBeLessThan(
      m.eventos.indexOf('elegibilidad'),
    );
    expect(m.eventos.indexOf('consumir')).toBeLessThan(
      m.eventos.indexOf('prueba'),
    );
  });

  it.each([['expired, unknown or already used', null]])(
    '%s: null and nothing else happens',
    async (_caso, fila) => {
      const m = montar({ fila, cuenta: {} });

      expect(await m.servicio.canjear(TOKEN)).toBeNull();

      expect(m.residencia.copropiedadesPorCorreo).not.toHaveBeenCalled();
      expect(m.cuentas.updateOne).not.toHaveBeenCalled();
      expect(m.auth.createCustomToken).not.toHaveBeenCalled();
    },
  );

  it('SEC: redeem re-checks eligibility (address removed or unit sold: nothing reached)', async () => {
    const m = montar({ copropiedades: new Map(), cuenta: {} });

    expect(await m.servicio.canjear(TOKEN)).toBeNull();

    expect(m.cuentas.updateOne).not.toHaveBeenCalled();
    expect(m.auth.createCustomToken).not.toHaveBeenCalled();
    // The link stays consumed: it was spent before the check.
    expect(m.enlaces.consumir).toHaveBeenCalledTimes(1);
  });

  it('SEC: redeem re-checks eligibility (revoked everywhere after the link was sent)', async () => {
    const m = montar({
      copropiedades: new Map([
        [COPRO_A, ['t1']],
        [COPRO_B, ['t2']],
      ]),
      revocadas: [COPRO_A, COPRO_B],
      cuenta: {},
    });
    const crear = jest.spyOn(m.servicio, 'crearCuentaPrimerUso');

    expect(await m.servicio.canjear(TOKEN)).toBeNull();

    expect(crear).not.toHaveBeenCalled();
    expect(m.cuentas.updateOne).not.toHaveBeenCalled();
  });

  it('a refusal for a brand new address creates no Account and no proof', async () => {
    const m = montar({ copropiedades: new Map(), cuenta: null });
    const crear = jest.spyOn(m.servicio, 'crearCuentaPrimerUso');

    expect(await m.servicio.canjear(TOKEN)).toBeNull();

    expect(crear).not.toHaveBeenCalled();
    expect(m.cuentas.updateOne).not.toHaveBeenCalled();
  });

  it('revoked in A, eligible in B: success, and nothing about A is granted here', async () => {
    const m = montar({
      copropiedades: new Map([
        [COPRO_A, ['t1']],
        [COPRO_B, ['t2']],
      ]),
      revocadas: [COPRO_A],
      cuenta: {},
    });

    expect(await m.servicio.canjear(TOKEN)).toEqual({
      resultado: 'sesion',
      customToken: 'custom-token-de-uid-1',
    });
  });

  it('any thrown error is a refusal (null), never an exception', async () => {
    const consumo = montar({ cuenta: {} });
    consumo.enlaces.consumir.mockRejectedValue(new Error('db down'));
    const lectura = montar({ cuenta: {} });
    lectura.residencia.copropiedadesPorCorreo.mockRejectedValue(
      new Error('db down'),
    );
    const firma = montar({ cuenta: {}, tokenFalla: true });

    await expect(consumo.servicio.canjear(TOKEN)).resolves.toBeNull();
    await expect(lectura.servicio.canjear(TOKEN)).resolves.toBeNull();
    await expect(firma.servicio.canjear(TOKEN)).resolves.toBeNull();
  });

  it('a token that fails to mint leaves no proof behind', async () => {
    const m = montar({ cuenta: {}, tokenFalla: true });

    expect(await m.servicio.canjear(TOKEN)).toBeNull();

    expect(m.cuentas.updateOne).not.toHaveBeenCalled();
  });
});

describe('IngresoPortalService.canjear - branches by the account of the address', () => {
  it('existing resident-only account: a session for it, no second Account', async () => {
    const m = montar({ cuenta: {}, accesos: [] });
    const crear = jest.spyOn(m.servicio, 'crearCuentaPrimerUso');

    const resultado = await m.servicio.canjear(TOKEN);

    expect(resultado).toEqual({
      resultado: 'sesion',
      customToken: 'custom-token-de-uid-1',
    });
    expect(m.auth.createCustomToken).toHaveBeenCalledWith('uid-1');
    expect(crear).not.toHaveBeenCalled();
  });

  it('Administración-only personal member: a session', async () => {
    const m = montar({ cuenta: {}, accesos: SOLO_ADMINISTRACION });

    expect(await m.servicio.canjear(TOKEN)).toMatchObject({
      resultado: 'sesion',
    });
  });

  it('SEC: staff with Finanzas keys never gets a session link', async () => {
    const m = montar({ cuenta: {}, accesos: CON_FINANZAS });

    const resultado = await m.servicio.canjear(TOKEN);

    expect(resultado).toEqual({ resultado: 'confirmado' });
    expect(JSON.stringify(resultado)).not.toContain('token');
    expect(m.auth.createCustomToken).not.toHaveBeenCalled();
    // The proof is still recorded.
    expect(m.cuentas.updateOne).toHaveBeenCalled();
  });

  it('a non-personal (administrativo) assignment: confirmado, no token, proof recorded', async () => {
    const m = montar({ cuenta: {}, accesos: [], noPersonal: true });

    expect(await m.servicio.canjear(TOKEN)).toEqual({
      resultado: 'confirmado',
    });
    expect(m.auth.createCustomToken).not.toHaveBeenCalled();
    expect(m.cuentas.updateOne).toHaveBeenCalled();
  });

  it('platform admin: confirmado, no token, and no access query at all', async () => {
    const m = montar({ cuenta: { esAdministradorPlataforma: true } });

    expect(await m.servicio.canjear(TOKEN)).toEqual({
      resultado: 'confirmado',
    });
    expect(m.auth.createCustomToken).not.toHaveBeenCalled();
    expect(m.acceso.copropiedadesDe).not.toHaveBeenCalled();
    expect(m.cuentas.updateOne).toHaveBeenCalled();
  });

  it('SEC: inactive account gets no proof', async () => {
    const m = montar({ cuenta: { estado: 'inactive' } });

    expect(await m.servicio.canjear(TOKEN)).toBeNull();

    expect(m.cuentas.updateOne).not.toHaveBeenCalled();
    expect(m.auth.createCustomToken).not.toHaveBeenCalled();
  });

  it('asks for the account reach with the account in hand (no extra read)', async () => {
    const m = montar({ cuenta: {}, accesos: [] });

    await m.servicio.canjear(TOKEN);

    expect(m.acceso.copropiedadesDe).toHaveBeenCalledWith(
      CUENTA_ID.toString(),
      false,
      expect.objectContaining({ email: CORREO }),
    );
  });

  it('writes nothing to assignments in any branch (the collaborator only reads)', async () => {
    const lecturaSolo = Object.keys(montar().asignaciones);
    expect(lecturaSolo).toEqual(['exists']);

    for (const over of [
      { accesos: [] },
      { accesos: CON_FINANZAS },
      { noPersonal: true },
      { cuenta: { esAdministradorPlataforma: true } },
    ]) {
      const m = montar({ cuenta: {}, ...over });
      await expect(m.servicio.canjear(TOKEN)).resolves.not.toBeNull();
      expect(Object.keys(m.asignaciones)).toEqual(['exists']);
    }
  });

  it('no Account: the first-use seam creates it, then the redeem goes on as an existing one', async () => {
    const m = montar({ cuenta: null, accesos: [] });
    const creada = cuentaDePrueba({ firebaseUid: 'rc1_nuevo' });
    const crear = jest
      .spyOn(m.servicio, 'crearCuentaPrimerUso')
      .mockResolvedValue(creada);

    const resultado = await m.servicio.canjear(TOKEN);

    expect(crear).toHaveBeenCalledTimes(1);
    expect(crear).toHaveBeenCalledWith(CORREO, [COPRO_A]);
    expect(resultado).toEqual({
      resultado: 'sesion',
      customToken: 'custom-token-de-rc1_nuevo',
    });
  });

  it('no Account and the seam fails: a refusal with no proof', async () => {
    const m = montar({ cuenta: null });
    jest
      .spyOn(m.servicio, 'crearCuentaPrimerUso')
      .mockRejectedValue(new Error('firebase down'));

    expect(await m.servicio.canjear(TOKEN)).toBeNull();

    expect(m.cuentas.updateOne).not.toHaveBeenCalled();
  });
});

describe('IngresoPortalService.canjear - the proof on the Account', () => {
  const AHORA = new Date('2026-11-12T10:00:00Z');
  beforeEach(() =>
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(AHORA),
  );
  afterEach(() => jest.useRealTimers());

  const tienda = (cuenta: Record<string, unknown>) => {
    const coleccion = new ColeccionMemoria();
    coleccion.insertar({ ...cuentaDePrueba(), ...cuenta });
    return coleccion;
  };

  it('first redeem sets the clave, when it was first proven and the last entry', async () => {
    const cuentas = tienda({});
    const m = montar({ cuentasEnMemoria: cuentas, accesos: [] });

    await m.servicio.canjear(TOKEN);

    const guardada = cuentas.docs[0];
    expect(guardada.correoProbadoClave).toBe(CLAVE);
    expect(guardada.correoProbadoEn).toEqual(AHORA);
    expect(guardada.ultimoIngresoPortalEn).toEqual(AHORA);
  });

  it('a second redeem keeps the first-proven date and moves the last entry', async () => {
    const primera = new Date('2026-11-01T08:00:00Z');
    const cuentas = tienda({
      correoProbadoClave: CLAVE,
      correoProbadoEn: primera,
      ultimoIngresoPortalEn: primera,
    });
    const m = montar({ cuentasEnMemoria: cuentas, accesos: [] });

    await m.servicio.canjear(TOKEN);

    const guardada = cuentas.docs[0];
    expect(guardada.correoProbadoEn).toEqual(primera);
    expect(guardada.ultimoIngresoPortalEn).toEqual(AHORA);
    expect(guardada.correoProbadoClave).toBe(CLAVE);
  });

  it('a stale proof (for another address) lapses: the date restarts with the new clave', async () => {
    const vieja = new Date('2026-01-01T08:00:00Z');
    const cuentas = tienda({
      correoProbadoClave: 'otra-clave',
      correoProbadoEn: vieja,
    });
    const m = montar({ cuentasEnMemoria: cuentas, accesos: [] });

    await m.servicio.canjear(TOKEN);

    const guardada = cuentas.docs[0];
    expect(guardada.correoProbadoClave).toBe(CLAVE);
    expect(guardada.correoProbadoEn).toEqual(AHORA);
  });

  it('confirmado records the proof too', async () => {
    const cuentas = tienda({});
    const m = montar({ cuentasEnMemoria: cuentas, noPersonal: true });

    await m.servicio.canjear(TOKEN);

    expect(cuentas.docs[0].correoProbadoClave).toBe(CLAVE);
    expect(cuentas.docs[0].ultimoIngresoPortalEn).toEqual(AHORA);
  });

  it('refusals write none: inactive account, ineligible address, spent link', async () => {
    const inactiva = tienda({ estado: 'inactive' });
    const a = montar({ cuentasEnMemoria: inactiva });
    const inelegible = tienda({});
    const b = montar({
      cuentasEnMemoria: inelegible,
      copropiedades: new Map(),
    });
    const gastada = tienda({});
    const c = montar({ cuentasEnMemoria: gastada, fila: null });

    await a.servicio.canjear(TOKEN);
    await b.servicio.canjear(TOKEN);
    await c.servicio.canjear(TOKEN);

    for (const coleccion of [inactiva, inelegible, gastada]) {
      expect(coleccion.docs[0].correoProbadoClave).toBe(null);
      expect(coleccion.docs[0].ultimoIngresoPortalEn).toBe(null);
      expect(coleccion.escrituras).toEqual([]);
    }
  });

  it('the Account is looked up by the normalized address of the link row', async () => {
    const m = montar({ cuenta: {}, accesos: [] });

    await m.servicio.canjear(TOKEN);

    expect(m.cuentas.findOne).toHaveBeenCalledWith({ email: CORREO });
    expect(new Types.ObjectId(CUENTA_ID).toString()).toBe(CUENTA_ID.toString());
  });
});

describe('IngresoPortalService.canjear - logs', () => {
  const NIVELES = ['log', 'debug', 'warn', 'error', 'verbose'] as const;
  const espias = NIVELES.map((nivel) =>
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined),
  );
  afterAll(() => espias.forEach((e) => e.mockRestore()));
  beforeEach(() => espias.forEach((e) => e.mockClear()));

  it('SEC: redeem logs carry no address, token, hash, uid or error text', async () => {
    const casos = [
      montar({ cuenta: {} }),
      montar({ cuenta: {}, fila: null }),
      montar({ cuenta: {}, copropiedades: new Map() }),
      montar({ cuenta: {}, tokenFalla: true }),
      montar({ cuenta: { estado: 'inactive' } }),
      montar({ cuenta: {}, accesos: CON_FINANZAS }),
    ];
    for (const m of casos) await m.servicio.canjear(TOKEN);

    const salida = espias
      .flatMap((e) => e.mock.calls as unknown[][])
      .map((llamada) => llamada.map(String).join(' '))
      .join(' | ')
      .toLowerCase();
    expect(salida).not.toContain('example.com');
    expect(salida).not.toContain(TOKEN);
    expect(salida).not.toContain(CLAVE);
    expect(salida).not.toContain('uid-1');
    expect(salida).not.toContain('firebase down');
  });
});

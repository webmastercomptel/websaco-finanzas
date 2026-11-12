import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import {
  CLAVE,
  COPRO_A,
  COPRO_B,
  CORREO,
  montar,
  TOKEN,
} from './testing/montar-servicio';

describe('IngresoPortalService.solicitar - eligibility', () => {
  it('SEC: mail goes only to an eligible address (titular or arrendatario of an active unit)', async () => {
    const m = montar();

    await m.servicio.solicitar(CORREO);

    expect(m.residencia.copropiedadesPorCorreo).toHaveBeenCalledWith(CORREO);
    expect(m.enlaces.crear).toHaveBeenCalledTimes(1);
    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
    const mensaje = (
      m.correo.enviar.mock.calls as [Record<string, unknown>][]
    )[0][0];
    // `to` only, never cc/bcc, and nothing else about the address.
    expect(mensaje.para).toBe(CORREO);
    expect(Object.keys(mensaje).sort()).toEqual(
      ['asunto', 'html', 'para', 'sinRegistrarDestinatario'].sort(),
    );
    expect(mensaje.sinRegistrarDestinatario).toBe(true);
    expect(String(mensaje.html)).toContain(`/ingreso#${TOKEN}`);
  });

  it.each([
    [
      'unknown, inactive party, no unit, inactive unit or coproperty, no module',
      new Map<string, string[]>(),
    ],
  ])('sends nothing when the address reaches no unit: %s', async (_c, mapa) => {
    const m = montar({ copropiedades: mapa });

    await m.servicio.solicitar(CORREO);

    expect(m.enlaces.crear).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('normalizes the spelling before everything: padded and upper case', async () => {
    const m = montar();

    await m.servicio.solicitar('  ANA@Example.COM ');

    expect(m.residencia.copropiedadesPorCorreo).toHaveBeenCalledWith(CORREO);
    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
    expect(
      (m.correo.enviar.mock.calls as [{ para: string }][])[0][0].para,
    ).toBe(CORREO);
    expect(m.enlaces.crear).toHaveBeenCalledWith(
      expect.objectContaining({ correo: CORREO, origen: 'autoservicio' }),
    );
  });

  it('revoked in A only: sends (the address still reaches B)', async () => {
    const m = montar({
      copropiedades: new Map([
        [COPRO_A, ['t1']],
        [COPRO_B, ['t2']],
      ]),
      revocadas: [COPRO_A],
    });

    await m.servicio.solicitar(CORREO);

    expect(m.residencia.revocacionesActivas).toHaveBeenCalledWith(CLAVE, [
      COPRO_A,
      COPRO_B,
    ]);
    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('revoked everywhere it qualifies: silent, no token', async () => {
    const m = montar({
      copropiedades: new Map([
        [COPRO_A, ['t1']],
        [COPRO_B, ['t2']],
      ]),
      revocadas: [COPRO_A, COPRO_B],
    });

    await m.servicio.solicitar(CORREO);

    expect(m.enlaces.crear).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('inactive Account: silent', async () => {
    const m = montar({ cuenta: { estado: 'inactive' } });

    await m.servicio.solicitar(CORREO);

    expect(m.enlaces.crear).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('active Account or no Account at all: sends', async () => {
    const conCuenta = montar({ cuenta: { estado: 'active' } });
    const sinCuenta = montar({ cuenta: null });

    await conCuenta.servicio.solicitar(CORREO);
    await sinCuenta.servicio.solicitar(CORREO);

    expect(conCuenta.correo.enviar).toHaveBeenCalledTimes(1);
    expect(sinCuenta.correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('three addresses on the party, one requested: one mail to that one', async () => {
    const m = montar();

    await m.servicio.solicitar('segundo@example.com');

    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
    expect(
      (m.correo.enviar.mock.calls as [{ para: string }][])[0][0].para,
    ).toBe('segundo@example.com');
    expect(m.residencia.copropiedadesPorCorreo).toHaveBeenCalledTimes(1);
  });

  it('a malformed string is silent and touches neither the lookup nor a counter', async () => {
    const m = montar();

    await m.servicio.solicitar('no-es-correo');
    await m.servicio.solicitar('');

    expect(m.residencia.copropiedadesPorCorreo).not.toHaveBeenCalled();
    expect(m.limite.permitir).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('evaluarElegibilidad tells the reason, for the staff resend', async () => {
    const sin = montar({ copropiedades: new Map() });
    const revocada = montar({ revocadas: [COPRO_A] });
    const inactiva = montar({ cuenta: { estado: 'inactive' } });
    const buena = montar();

    expect((await sin.servicio.evaluarElegibilidad(CORREO)).motivo).toBe(
      'sin-registro',
    );
    expect((await revocada.servicio.evaluarElegibilidad(CORREO)).motivo).toBe(
      'revocado',
    );
    expect((await inactiva.servicio.evaluarElegibilidad(CORREO)).motivo).toBe(
      'cuenta-inactiva',
    );
    const ok = await buena.servicio.evaluarElegibilidad(CORREO);
    expect(ok.elegible).toBe(true);
    expect(ok.copropiedadIds).toEqual([COPRO_A]);
  });
});

describe('IngresoPortalService.solicitar - limits', () => {
  it('SEC: address counter is blind to being known', async () => {
    const conocido = montar();
    const desconocido = montar({ copropiedades: new Map() });

    await conocido.servicio.solicitar(CORREO);
    await desconocido.servicio.solicitar(CORREO);

    expect(desconocido.llamadasPermitir).toEqual(conocido.llamadasPermitir);
    expect(conocido.llamadasPermitir).toEqual([
      `limite:ingreso-correo:15m:${CLAVE}`,
      `limite:ingreso-correo:24h:${CLAVE}`,
    ]);
    expect(conocido.limite.permitir).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      3,
      15 * 60 * 1000,
    );
    expect(conocido.limite.permitir).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      10,
      24 * 60 * 60 * 1000,
    );
  });

  it('both windows are counted even when the short one is already over', async () => {
    const m = montar({ permisos: [false, true] });

    await m.servicio.solicitar(CORREO);

    expect(m.limite.permitir).toHaveBeenCalledTimes(2);
    expect(m.enlaces.crear).not.toHaveBeenCalled();
  });

  it('over the short window: silent, no lookup of the address', async () => {
    const m = montar({ permisos: [false, true] });

    await m.servicio.solicitar(CORREO);

    expect(m.residencia.copropiedadesPorCorreo).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('over the 24 hour window (spaced to stay under 15 minutes): silent', async () => {
    const m = montar({ permisos: [true, false] });

    await m.servicio.solicitar(CORREO);

    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(m.enlaces.crear).not.toHaveBeenCalled();
  });

  it('Redis down at this step (the limiter answers false): silent, nothing sent', async () => {
    const m = montar({ permisos: () => false });

    await m.servicio.solicitar(CORREO);

    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('no limiter key holds the address', async () => {
    const m = montar();

    await m.servicio.solicitar(CORREO);

    for (const clave of m.llamadasPermitir) {
      expect(clave.toLowerCase()).not.toContain('ana');
      expect(clave.toLowerCase()).not.toContain('example');
      expect(clave).toContain(CLAVE);
    }
  });

  it('tomarCupoCorreo is the shared counter of the staff resend', async () => {
    const m = montar({ permisos: [true, true, true, false] });

    expect(await m.servicio.tomarCupoCorreo(CORREO)).toBe(true);
    expect(await m.servicio.tomarCupoCorreo(CORREO)).toBe(false);
  });
});

describe('IngresoPortalService.solicitar - silence', () => {
  const NIVELES = ['log', 'debug', 'warn', 'error', 'verbose'] as const;
  const espias = NIVELES.map((nivel) =>
    jest.spyOn(Logger.prototype, nivel).mockImplementation(() => undefined),
  );
  afterAll(() => espias.forEach((e) => e.mockRestore()));
  beforeEach(() => espias.forEach((e) => e.mockClear()));

  const registrado = (): string =>
    espias
      .flatMap((e) => e.mock.calls as unknown[][])
      .map((llamada) => llamada.map(String).join(' '))
      .join(' | ');

  const sinRastro = (): void => {
    const salida = registrado().toLowerCase();
    expect(salida).not.toContain('ana@example.com');
    expect(salida).not.toContain('example.com');
    expect(salida).not.toContain(TOKEN);
    expect(salida).not.toContain(CLAVE);
    expect(salida).not.toContain('tokenhash');
    expect(salida).not.toContain('203.0.113');
  };

  it('SEC: request work logs no address or token (mail not configured)', async () => {
    const m = montar({ configurado: false });

    await expect(m.servicio.solicitar(CORREO)).resolves.toBeUndefined();

    expect(m.enlaces.crear).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
    sinRastro();
  });

  it('SEC: request work logs no address or token (provider rejects)', async () => {
    const m = montar({ enviado: false });

    await expect(m.servicio.solicitar(CORREO)).resolves.toBeUndefined();

    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
    expect(registrado()).not.toBe('');
    sinRastro();
  });

  it('SEC: request work logs no address or token (database error, even one that echoes keys)', async () => {
    const m = montar({ crearFalla: true });

    await expect(m.servicio.solicitar(CORREO)).resolves.toBeUndefined();

    expect(registrado()).not.toBe('');
    sinRastro();
  });

  it('SEC: request work logs no address or token (lookup throws)', async () => {
    const m = montar();
    m.residencia.copropiedadesPorCorreo.mockRejectedValue(
      new Error(`connection lost for ${CORREO}`),
    );

    await expect(m.servicio.solicitar(CORREO)).resolves.toBeUndefined();

    sinRastro();
  });

  it('a missing or malformed FRONTEND_URL sends nothing and mints nothing', async () => {
    const falta = montar({ frontendUrl: undefined });
    const mala = montar({ frontendUrl: 'https://app.ejemplo.com/ruta?x=1' });

    await falta.servicio.solicitar(CORREO);
    await mala.servicio.solicitar(CORREO);

    expect(falta.enlaces.crear).not.toHaveBeenCalled();
    expect(mala.enlaces.crear).not.toHaveBeenCalled();
    expect(falta.correo.enviar).not.toHaveBeenCalled();
    sinRastro();
  });
});

describe('IngresoPortalService.emitirYEnviar', () => {
  it('answers the outcome the staff resend needs', async () => {
    const bien = montar();
    const sinCorreo = montar({ configurado: false });
    const rechazado = montar({ enviado: false });

    expect(
      await bien.servicio.emitirYEnviar(
        CORREO,
        'personal',
        new Types.ObjectId(),
      ),
    ).toBe('enviado');
    expect(
      await sinCorreo.servicio.emitirYEnviar(CORREO, 'personal', null),
    ).toBe('sin-correo-configurado');
    expect(
      await rechazado.servicio.emitirYEnviar(CORREO, 'personal', null),
    ).toBe('fallo');
    expect(bien.enlaces.crear).toHaveBeenCalledWith(
      expect.objectContaining({ origen: 'personal' }),
    );
  });

  it('mints no token when mail is not configured (a live credential for nothing)', async () => {
    const m = montar({ configurado: false });

    await m.servicio.emitirYEnviar(CORREO, 'autoservicio', null);

    expect(m.enlaces.crear).not.toHaveBeenCalled();
  });
});

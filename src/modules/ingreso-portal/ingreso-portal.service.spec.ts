import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { ResidenciaService } from '../../common/acceso/residencia.service';
import { ColeccionMemoria } from '../envio-facturas/testing/coleccion-memoria';
import { EnlaceIngresoService } from './enlace-ingreso.service';
import {
  CLAVE,
  COPRO_A,
  COPRO_B,
  CORREO,
  montar,
  TOKEN,
} from './testing/montar-servicio';
import { REGLA_BUZON_COMPARTIDO_ACTIVA } from '../../common/acceso/residencia.reglas';
const itConRegla = REGLA_BUZON_COMPARTIDO_ACTIVA ? it : it.skip;

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
  const IP = '203.0.113.7';
  const QUINCE = 15 * 60 * 1000;
  const DIA = 24 * 60 * 60 * 1000;
  const sha = (texto: string): string =>
    createHash('sha256').update(texto).digest('hex');
  const ORIGEN = sha(`${CLAVE}|${IP}`);

  it('SEC: address counter is blind to being known (the per-source window runs before any lookup)', async () => {
    const conocido = montar();
    const desconocido = montar({ copropiedades: new Map() });

    await conocido.servicio.solicitar(CORREO, IP);
    await desconocido.servicio.solicitar(CORREO, IP);

    const antes = [
      `limite:ingreso-correo-origen:15m:${ORIGEN}`,
      `limite:ingreso-correo-origen:24h:${ORIGEN}`,
    ];
    expect(desconocido.llamadasPermitir).toEqual(antes);
    expect(conocido.llamadasPermitir.slice(0, 2)).toEqual(antes);
    expect(conocido.limite.permitir).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      3,
      QUINCE,
    );
    expect(conocido.limite.permitir).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      20,
      DIA,
    );
  });

  it('the per-address windows are taken only AFTER eligibility, and are well above the per-source ones', async () => {
    const m = montar();

    await m.servicio.solicitar(CORREO, IP);

    expect(m.llamadasPermitir.slice(2)).toEqual([
      `limite:ingreso-correo:15m:${CLAVE}`,
      `limite:ingreso-correo:24h:${CLAVE}`,
    ]);
    expect(m.limite.permitir).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      10,
      QUINCE,
    );
    expect(m.limite.permitir).toHaveBeenNthCalledWith(
      4,
      expect.any(String),
      60,
      DIA,
    );
    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('SEC: an ineligible address never touches the per-address windows', async () => {
    const m = montar({ revocadas: [COPRO_A] });

    await m.servicio.solicitar(CORREO, IP);

    expect(m.llamadasPermitir).toHaveLength(2);
    expect(m.llamadasPermitir.some((k) => k.includes(CLAVE))).toBe(false);
  });

  it('both per-source windows are counted even when the short one is already over', async () => {
    const m = montar({ permisos: [false, true] });

    await m.servicio.solicitar(CORREO, IP);

    expect(m.limite.permitir).toHaveBeenCalledTimes(2);
    expect(m.residencia.copropiedadesPorCorreo).not.toHaveBeenCalled();
    expect(m.enlaces.crear).not.toHaveBeenCalled();
  });

  it('over the per-source 24 hour window: silent, no lookup', async () => {
    const m = montar({ permisos: [true, false] });

    await m.servicio.solicitar(CORREO, IP);

    expect(m.residencia.copropiedadesPorCorreo).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('over a per-address window: both counted, silent, nothing minted', async () => {
    const m = montar({ permisos: [true, true, false, true] });

    await m.servicio.solicitar(CORREO, IP);

    expect(m.limite.permitir).toHaveBeenCalledTimes(4);
    expect(m.enlaces.crear).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('Redis down at this step (the limiter answers false): silent, nothing sent', async () => {
    const m = montar({ permisos: () => false });

    await m.servicio.solicitar(CORREO, IP);

    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('SEC: one source cannot lock an address out (a flood from one IP leaves the address served from another)', async () => {
    const contador = new Map<string, number>();
    const atacante = montar({ contador });
    for (let i = 0; i < 50; i += 1) {
      await atacante.servicio.solicitar(CORREO, IP);
    }
    // A /64 rotating its low bits is ONE source.
    for (let i = 0; i < 20; i += 1) {
      await atacante.servicio.solicitar(CORREO, `2001:db8:1:2::${i + 1}`);
    }
    // 3 from the IPv4 source and 3 from the /64 (their short windows).
    expect(atacante.correo.enviar).toHaveBeenCalledTimes(6);

    const victima = montar({ contador });
    await victima.servicio.solicitar(CORREO, '198.51.100.20');
    expect(victima.correo.enviar).toHaveBeenCalledTimes(1);
  });

  it('the per-address cap still holds across many sources', async () => {
    const contador = new Map<string, number>();
    const m = montar({ contador });
    for (let i = 0; i < 12; i += 1) {
      await m.servicio.solicitar(CORREO, `198.51.100.${i + 1}`);
    }
    expect(m.correo.enviar).toHaveBeenCalledTimes(10);
  });

  it('no limiter key holds the address or the IP', async () => {
    const m = montar();

    await m.servicio.solicitar(CORREO, IP);
    await m.servicio.tomarCupoReenvio(CORREO);

    expect(m.llamadasPermitir).toHaveLength(6);
    for (const clave of m.llamadasPermitir) {
      expect(clave.toLowerCase()).not.toContain('ana');
      expect(clave.toLowerCase()).not.toContain('example');
      expect(clave).not.toContain('203.0.113');
      expect(clave).toMatch(/:[0-9a-f]{64}$/);
    }
  });

  it('SEC: the staff resend has its own counter: self-service exhaustion never blocks it', async () => {
    const contador = new Map<string, number>();
    const m = montar({ contador });
    for (let i = 0; i < 40; i += 1) {
      await m.servicio.solicitar(CORREO, `198.51.100.${i + 1}`);
    }

    expect(await m.servicio.tomarCupoReenvio(CORREO)).toBe(true);
    expect(m.llamadasPermitir.slice(-2)).toEqual([
      `limite:ingreso-reenvio:15m:${CLAVE}`,
      `limite:ingreso-reenvio:24h:${CLAVE}`,
    ]);
  });

  it('tomarCupoReenvio keeps the spec outcome: the 4th staff resend in 15 minutes is over the limit', async () => {
    const m = montar({ contador: new Map() });

    for (let i = 0; i < 3; i += 1) {
      expect(await m.servicio.tomarCupoReenvio(CORREO)).toBe(true);
    }
    expect(await m.servicio.tomarCupoReenvio(CORREO)).toBe(false);
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

describe('IngresoPortalService.emitirYEnviar - older links die only after a sent e-mail', () => {
  const tokenDelCorreo = (enviar: jest.Mock): string => {
    const html = String((enviar.mock.calls as [{ html: string }][])[0][0].html);
    const encontrado = /\/ingreso#([0-9a-f]{64})/.exec(html);
    if (!encontrado) throw new Error('sin enlace en el correo');
    return encontrado[1];
  };

  const conEnlaceVivo = async () => {
    const almacen = new EnlaceIngresoService(
      new ColeccionMemoria(['tokenHash']) as never,
    );
    const viejo = await almacen.crear({ correo: CORREO });
    await almacen.confirmarEnvio(viejo);
    return { almacen, viejo };
  };

  it('SEC: the provider fails: the older link is still redeemable and the new one never is', async () => {
    const { almacen, viejo } = await conEnlaceVivo();
    const m = montar({ enlacesReales: almacen, enviado: false });

    await m.servicio.solicitar(CORREO);

    const nuevo = tokenDelCorreo(m.correo.enviar);
    expect(await almacen.consumir(nuevo)).toBeNull();
    expect(await almacen.consumir(viejo.token)).not.toBeNull();
  });

  it('SEC: the provider throws: same outcome, and the request stays silent', async () => {
    const { almacen, viejo } = await conEnlaceVivo();
    const m = montar({ enlacesReales: almacen, envioLanza: true });

    await expect(m.servicio.solicitar(CORREO)).resolves.toBeUndefined();

    const nuevo = tokenDelCorreo(m.correo.enviar);
    expect(await almacen.consumir(nuevo)).toBeNull();
    expect(await almacen.consumir(viejo.token)).not.toBeNull();
  });

  it('the provider accepts: only the new link is redeemable', async () => {
    const { almacen, viejo } = await conEnlaceVivo();
    const m = montar({ enlacesReales: almacen });

    await m.servicio.solicitar(CORREO);

    const nuevo = tokenDelCorreo(m.correo.enviar);
    expect(await almacen.consumir(viejo.token)).toBeNull();
    expect(await almacen.consumir(nuevo)).not.toBeNull();
  });

  it('order: mint, send, and only then confirm (never confirm a failed send)', async () => {
    const bien = montar();
    const mal = montar({ enviado: false });

    await bien.servicio.emitirYEnviar(CORREO, 'autoservicio', null);
    await mal.servicio.emitirYEnviar(CORREO, 'autoservicio', null);

    expect(bien.eventos).toEqual(['crear', 'enviar', 'confirmar']);
    expect(mal.eventos).toEqual(['crear', 'enviar', 'anular']);
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

/**
 * Generic inboxes, through the REAL `ResidenciaService` the portal access also
 * uses, so the request step and the access can never disagree.
 */
describe('IngresoPortalService.solicitar - buzones genéricos', () => {
  const cadena = (filas: Record<string, unknown>[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['collation', 'select', 'lean', 'sort']) c[m] = () => c;
    c.exec = () => Promise.resolve(filas);
    return { find: jest.fn(() => c) };
  };

  const residenciaReal = (partes: number) => {
    const copro = new Types.ObjectId(COPRO_A);
    const terceros = Array.from({ length: partes }, () => ({
      _id: new Types.ObjectId(),
      copropiedadId: copro,
      emails: [CORREO],
    }));
    return new ResidenciaService(
      cadena(terceros) as never,
      cadena(
        terceros.map((t) => ({
          _id: new Types.ObjectId(),
          copropiedadId: copro,
          titularId: t._id,
          arrendatarioId: null,
        })),
      ) as never,
      cadena([{ _id: copro, modulosContratados: ['finanzas'] }]) as never,
      cadena([]) as never,
    );
  };

  it('3 terceros con la dirección: se envía el enlace', async () => {
    const m = montar({ residenciaReal: residenciaReal(3) });

    await m.servicio.solicitar(CORREO);

    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
  });

  // Pinned while the shared-inbox rule is ON; it is OFF since 2026-11-12.
  itConRegla(
    '4 terceros con la dirección: silencio, sin token ni correo, motivo correo-generico',
    async () => {
      const m = montar({ residenciaReal: residenciaReal(4) });

      await m.servicio.solicitar(CORREO);

      expect(m.enlaces.crear).not.toHaveBeenCalled();
      expect(m.correo.enviar).not.toHaveBeenCalled();
      await expect(m.servicio.evaluarElegibilidad(CORREO)).resolves.toEqual({
        elegible: false,
        motivo: 'correo-generico',
        copropiedadIds: [],
      });
    },
  );

  it('la dirección de un miembro del personal, titular en UNA ficha: se envía el enlace (los accesos se suman)', async () => {
    // A staff Account with that address and an active assignment: the
    // residency rule never asks, so nothing about it can refuse the link.
    const m = montar({
      residenciaReal: residenciaReal(1),
      cuenta: { estado: 'active' },
      noPersonal: true,
    });

    await m.servicio.solicitar(CORREO);

    expect(m.correo.enviar).toHaveBeenCalledTimes(1);
    expect((await m.servicio.evaluarElegibilidad(CORREO)).elegible).toBe(true);
  });

  it('SEC: ese miembro del personal canjea el enlace SIN sesión (confirmado): la política de sesión sigue aparte', async () => {
    const m = montar({
      residenciaReal: residenciaReal(1),
      cuenta: { estado: 'active' },
      noPersonal: true,
    });

    await expect(m.servicio.canjear(TOKEN)).resolves.toEqual({
      resultado: 'confirmado',
    });
    expect(m.auth.createCustomToken).not.toHaveBeenCalled();
  });
});

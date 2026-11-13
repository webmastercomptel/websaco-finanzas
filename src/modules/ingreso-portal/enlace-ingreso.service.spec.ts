import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Types } from 'mongoose';
import { claveCorreo } from '../../common/utils/email.utils';
import { ColeccionMemoria } from '../envio-facturas/testing/coleccion-memoria';
import {
  construirEnlaceIngreso,
  EnlaceIngresoService,
} from './enlace-ingreso.service';
import { VIGENCIA_ENLACE_INGRESO_MS } from './ingreso-portal.constantes';

const sha256 = (valor: string): string =>
  createHash('sha256').update(valor).digest('hex');

const CORREO = 'ana@example.com';
const OTRO = 'otro@example.com';
const AHORA = new Date('2026-11-12T10:00:00Z');

function montar() {
  const coleccion = new ColeccionMemoria(['tokenHash']);
  const servicio = new EnlaceIngresoService(coleccion as never);
  return { coleccion, servicio };
}

describe('EnlaceIngresoService.crear', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(AHORA));
  afterEach(() => jest.useRealTimers());

  it('SEC: sign-in token is never persisted', async () => {
    const { coleccion, servicio } = montar();

    const { token } = await servicio.crear({ correo: CORREO });

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(coleccion.docs).toHaveLength(1);
    const fila = coleccion.docs[0];
    expect(fila.tokenHash).toBe(sha256(token));
    expect(fila.clave).toBe(claveCorreo(CORREO));
    // No field of the stored row holds the token.
    expect(JSON.stringify(fila)).not.toContain(token);
    for (const valor of Object.values(fila)) {
      expect(valor).not.toBe(token);
    }
  });

  it('expires 15 minutes after creation and stores the normalized address', async () => {
    const { coleccion, servicio } = montar();

    const { expiraEn } = await servicio.crear({ correo: '  ANA@Example.com ' });

    const fila = coleccion.docs[0];
    expect(fila.correo).toBe(CORREO);
    expect(VIGENCIA_ENLACE_INGRESO_MS).toBe(15 * 60 * 1000);
    expect((fila.expiraEn as Date).getTime()).toBe(
      Date.now() + VIGENCIA_ENLACE_INGRESO_MS,
    );
    expect(expiraEn.getTime()).toBe(Date.now() + VIGENCIA_ENLACE_INGRESO_MS);
    expect(fila.usadoEn).toBeNull();
    expect(fila.origen).toBe('autoservicio');
    expect(fila.solicitadoPor).toBeNull();
  });

  it('keeps who asked and the origin of a staff resend', async () => {
    const { coleccion, servicio } = montar();
    const personal = new Types.ObjectId();

    await servicio.crear({
      correo: CORREO,
      origen: 'personal',
      solicitadoPor: personal,
    });

    expect(coleccion.docs[0].origen).toBe('personal');
    expect(String(coleccion.docs[0].solicitadoPor)).toBe(String(personal));
  });

  it('minting alone kills nothing: an earlier link stays live until the new one is confirmed sent', async () => {
    const { servicio } = montar();

    const primero = await servicio.crear({ correo: CORREO });
    await servicio.confirmarEnvio(primero);
    await servicio.crear({ correo: CORREO });

    expect(await servicio.consumir(primero.token)).not.toBeNull();
  });

  it('two requests for one address, both sent: the first invalid and the second the only live one', async () => {
    const { servicio } = montar();

    const primero = await servicio.crear({ correo: CORREO });
    await servicio.confirmarEnvio(primero);
    const segundo = await servicio.crear({ correo: CORREO });
    await servicio.confirmarEnvio(segundo);

    expect(primero.token).not.toBe(segundo.token);
    expect(await servicio.consumir(primero.token)).toBeNull();
    expect(await servicio.consumir(segundo.token)).not.toBeNull();
  });

  it('a link for another address is untouched', async () => {
    const { servicio } = montar();

    const ajeno = await servicio.crear({ correo: OTRO });
    await servicio.confirmarEnvio(ajeno);
    const propio = await servicio.crear({ correo: CORREO });
    await servicio.confirmarEnvio(propio);

    expect(await servicio.consumir(ajeno.token)).not.toBeNull();
  });

  it('confirming kills older unused links in ONE updateMany that excludes the new one', async () => {
    const { coleccion, servicio } = montar();
    const nuevo = await servicio.crear({ correo: CORREO });
    const espia = jest.spyOn(coleccion, 'updateMany');

    await servicio.confirmarEnvio(nuevo);

    expect(espia).toHaveBeenCalledTimes(1);
    expect(espia.mock.calls[0][0]).toEqual({
      clave: claveCorreo(CORREO),
      usadoEn: null,
      _id: { $lt: nuevo.id },
    });
  });

  it.each([
    ['in order', [0, 1, 2]],
    ['in reverse', [2, 1, 0]],
    ['mixed', [1, 2, 0]],
  ])(
    'simultaneous links confirmed %s leave exactly one live link, the newest',
    async (_caso, orden) => {
      const { coleccion, servicio } = montar();

      const emitidos = await Promise.all([
        servicio.crear({ correo: CORREO }),
        servicio.crear({ correo: CORREO }),
        servicio.crear({ correo: CORREO }),
      ]);
      await Promise.all(orden.map((i) => servicio.confirmarEnvio(emitidos[i])));

      const vivas = coleccion.docs.filter((d) => d.usadoEn === null);
      expect(vivas).toHaveLength(1);
      const masNuevo = [...emitidos].sort((x, y) =>
        String(x.id).localeCompare(String(y.id)),
      )[2];
      expect(String(vivas[0]._id)).toBe(String(masNuevo.id));
    },
  );

  it('SEC: a voided link can never be redeemed, and the older live one stays redeemable', async () => {
    const { servicio } = montar();
    const viejo = await servicio.crear({ correo: CORREO });
    await servicio.confirmarEnvio(viejo);

    const nuevo = await servicio.crear({ correo: CORREO });
    await servicio.anular(nuevo);

    expect(await servicio.consumir(nuevo.token)).toBeNull();
    expect(await servicio.consumir(viejo.token)).not.toBeNull();
  });
});

describe('EnlaceIngresoService.consumir', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(AHORA));
  afterEach(() => jest.useRealTimers());

  it('SEC: a token is consumed exactly once', async () => {
    const { servicio } = montar();
    const { token } = await servicio.crear({ correo: CORREO });

    const primero = await servicio.consumir(token);
    const segundo = await servicio.consumir(token);

    expect(primero).toEqual({
      clave: claveCorreo(CORREO),
      correo: CORREO,
      origen: 'autoservicio',
      solicitadoPor: null,
    });
    expect(segundo).toBeNull();
  });

  it('SEC: simultaneous consumes of one token let exactly one through', async () => {
    const { servicio } = montar();
    const { token } = await servicio.crear({ correo: CORREO });

    const resultados = await Promise.all([
      servicio.consumir(token),
      servicio.consumir(token),
      servicio.consumir(token),
      servicio.consumir(token),
    ]);

    expect(resultados.filter((r) => r !== null)).toHaveLength(1);
  });

  it('filters on an unused, unexpired row in the same atomic write', async () => {
    const findOneAndUpdate = jest.fn().mockReturnValue({
      lean: () => ({ exec: () => Promise.resolve(null) }),
    });
    const servicio = new EnlaceIngresoService({ findOneAndUpdate } as never);
    const token = 'a'.repeat(64);

    await servicio.consumir(token);

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filtro, cambio] = findOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filtro.tokenHash).toBe(sha256(token));
    expect(filtro.usadoEn).toBeNull();
    expect(filtro.expiraEn).toEqual({ $gt: expect.any(Date) as unknown });
    expect(Object.keys(cambio)).toEqual(['$set']);
    expect(cambio.$set.usadoEn).toBeInstanceOf(Date);
  });

  it('accepts at 14:59 and refuses at 15:01 even if the TTL has not run', async () => {
    const { servicio } = montar();
    const a = await servicio.crear({ correo: CORREO });
    const b = await servicio.crear({ correo: OTRO });

    jest.setSystemTime(AHORA.getTime() + 14 * 60_000 + 59_000);
    expect(await servicio.consumir(a.token)).not.toBeNull();

    jest.setSystemTime(AHORA.getTime() + 15 * 60_000 + 1_000);
    expect(await servicio.consumir(b.token)).toBeNull();
  });

  it('answers null without touching the store for a malformed token', async () => {
    const findOneAndUpdate = jest.fn();
    const servicio = new EnlaceIngresoService({ findOneAndUpdate } as never);

    for (const malo of [
      '',
      'hola',
      'A'.repeat(64),
      'a'.repeat(63),
      'a'.repeat(65),
    ]) {
      expect(await servicio.consumir(malo)).toBeNull();
    }
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('answers null for an unknown token', async () => {
    const { servicio } = montar();
    expect(await servicio.consumir('b'.repeat(64))).toBeNull();
  });
});

describe('construirEnlaceIngreso', () => {
  it('puts the token in the fragment of /ingreso and nowhere else', () => {
    const token = 'c'.repeat(64);

    const enlace = construirEnlaceIngreso('https://app.ejemplo.com', token);

    expect(enlace).toBe(`https://app.ejemplo.com/ingreso#${token}`);
    const url = new URL(enlace);
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/ingreso');
    expect(url.hash).toBe(`#${token}`);
  });
});

describe('ingreso-portal module', () => {
  it('SEC: ingreso never reads invoice-link usage (no module file touches that model)', () => {
    const carpeta = __dirname;
    const archivos = readdirSync(carpeta, { recursive: true })
      .map(String)
      // This scan names the forbidden identifiers on purpose.
      .filter(
        (f) => f.endsWith('.ts') && f !== 'enlace-ingreso.service.spec.ts',
      );
    expect(archivos.length).toBeGreaterThan(0);
    for (const archivo of archivos) {
      const fuente = readFileSync(join(carpeta, archivo), 'utf8');
      expect(fuente).not.toMatch(
        /EnlaceFactura|enlace-factura|enlaces_factura/,
      );
    }
  });
});

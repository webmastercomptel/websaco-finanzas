// src/modules/ingreso-portal/ingreso-portal.constantes.ts
import { createHash } from 'node:crypto';
import { segmentoIp } from '../../common/publico/segmento-ip';

/**
 * How long a sign-in link works from the moment it is minted. Flip point for
 * "the link lasts 15 minutes" (assumption A4): the e-mail text derives its
 * "vence en N minutos" sentence from this constant, and links already sent keep
 * the `expiraEn` stored on their row.
 */
export const VIGENCIA_ENLACE_INGRESO_MS = 15 * 60 * 1000;

/**
 * The request route answers at EXACTLY this long after it began, whatever the
 * address is: the work (limits, lookup, token, e-mail) runs in the background
 * and the 202 leaves on the clock, so neither a slow provider nor a known
 * address can be measured.
 */
export const PISO_SOLICITUD_MS = 1500;

/** A redeem refusal never answers before this long, so timing does not tell the stage. */
export const PISO_CANJE_MS = 300;

/** A well-formed token: 32 random bytes in lowercase hex. */
export const FORMATO_TOKEN_INGRESO = /^[0-9a-f]{64}$/;

/** The one body of every request answer. */
export const MENSAJE_SOLICITUD =
  'Si tu correo está registrado, te enviamos un enlace para entrar.';

/** The one message of every redeem refusal (the existing access link's sentence). */
export const MENSAJE_CANJE_INVALIDO = 'El enlace no es válido o venció';

/** The existing rate-limit sentence. */
export const MENSAJE_DEMASIADOS_INTENTOS =
  'Demasiados intentos. Espera un minuto e inténtalo de nuevo.';

/**
 * Rate limits, all through `LimiteIntentosService` (fixed window, Redis, fails
 * closed). There is deliberately NO global bucket: one counting every request
 * would let anyone lock every resident out. Keys are built from a hash or the
 * IP, never from an address or a raw token.
 */
export const LIMITES_INGRESO = {
  /** Per client IP on the request route; over it the route answers 429. */
  solicitudPorIp: { limite: 10, ventanaMs: 60_000 },
  /**
   * Per (address, client source): the TIGHT window of a self-service request,
   * counted before any lookup so known and unknown addresses cost the same.
   * One source (an IPv4 address or an IPv6 /64) can therefore trigger at most
   * 20 links a day for an address, well below the per-address cap below, so it
   * cannot exhaust that cap and lock the owner out.
   */
  correoOrigenCorta: { limite: 3, ventanaMs: 15 * 60 * 1000 },
  correoOrigenLarga: { limite: 20, ventanaMs: 24 * 60 * 60 * 1000 },
  /**
   * Per address (by `clave`), self-service only, taken only AFTER the address
   * proved eligible: it caps how many links reach one inbox from all sources
   * together. Well above the per-source windows (3 sources are needed to fill
   * the daily one). Raised on 2026-11-12 at the owner's request: the short
   * window stops bursts, the daily caps only exist to stop abuse.
   */
  correoCorta: { limite: 10, ventanaMs: 15 * 60 * 1000 },
  correoLarga: { limite: 60, ventanaMs: 24 * 60 * 60 * 1000 },
  /**
   * Per address, the staff resend's OWN counter (spec REQ-R2 values: the 4th
   * resend in 15 minutes is `motivo: 'limite'`). Separate from self-service,
   * so a stranger flooding the public route never blocks staff.
   */
  reenvioCorta: { limite: 3, ventanaMs: 15 * 60 * 1000 },
  reenvioLarga: { limite: 20, ventanaMs: 24 * 60 * 60 * 1000 },
  /** Per client IP on the redeem route. */
  canjePorIp: { limite: 20, ventanaMs: 60_000 },
  /** Per token (by its hash) on the redeem route. */
  canjePorToken: { limite: 5, ventanaMs: 60_000 },
} as const;

/** SHA-256 of the address key and the client source (`segmentoIp`). */
const digestoOrigen = (clave: string, ip: string | undefined): string =>
  createHash('sha256')
    .update(`${clave}|${segmentoIp(ip)}`)
    .digest('hex');

/**
 * Redis key builders. The variable part is an IP (an IPv6 one counted as its
 * /64, `segmentoIp`) or a hash, never an address.
 */
export const clavesLimite = {
  solicitudIp: (ip: string | undefined): string =>
    `limite:ingreso-solicitar:ip:${segmentoIp(ip)}`,
  /** (address, source) as ONE digest: neither the address nor the IP is in the key. */
  correoOrigenCorta: (clave: string, ip: string | undefined): string =>
    `limite:ingreso-correo-origen:15m:${digestoOrigen(clave, ip)}`,
  correoOrigenLarga: (clave: string, ip: string | undefined): string =>
    `limite:ingreso-correo-origen:24h:${digestoOrigen(clave, ip)}`,
  correoCorta: (clave: string): string => `limite:ingreso-correo:15m:${clave}`,
  correoLarga: (clave: string): string => `limite:ingreso-correo:24h:${clave}`,
  reenvioCorta: (clave: string): string =>
    `limite:ingreso-reenvio:15m:${clave}`,
  reenvioLarga: (clave: string): string =>
    `limite:ingreso-reenvio:24h:${clave}`,
  canjeIp: (ip: string | undefined): string =>
    `limite:ingreso-canjear:ip:${segmentoIp(ip)}`,
  canjeToken: (hashDelToken: string): string =>
    `limite:ingreso-canjear:token:${hashDelToken}`,
};

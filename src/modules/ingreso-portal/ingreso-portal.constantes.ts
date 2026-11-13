// src/modules/ingreso-portal/ingreso-portal.constantes.ts
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
  /** Per address (by `clave`), request and staff resend: both windows apply. */
  correoCorta: { limite: 3, ventanaMs: 15 * 60 * 1000 },
  correoLarga: { limite: 10, ventanaMs: 24 * 60 * 60 * 1000 },
  /** Per client IP on the redeem route. */
  canjePorIp: { limite: 20, ventanaMs: 60_000 },
  /** Per token (by its hash) on the redeem route. */
  canjePorToken: { limite: 5, ventanaMs: 60_000 },
} as const;

/**
 * Redis key builders. The variable part is an IP (an IPv6 one counted as its
 * /64, `segmentoIp`) or a hash, never an address.
 */
export const clavesLimite = {
  solicitudIp: (ip: string | undefined): string =>
    `limite:ingreso-solicitar:ip:${segmentoIp(ip)}`,
  correoCorta: (clave: string): string => `limite:ingreso-correo:15m:${clave}`,
  correoLarga: (clave: string): string => `limite:ingreso-correo:24h:${clave}`,
  canjeIp: (ip: string | undefined): string =>
    `limite:ingreso-canjear:ip:${segmentoIp(ip)}`,
  canjeToken: (hashDelToken: string): string =>
    `limite:ingreso-canjear:token:${hashDelToken}`,
};

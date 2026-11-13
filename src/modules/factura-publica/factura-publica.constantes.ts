// src/modules/factura-publica/factura-publica.constantes.ts

/**
 * How long a public invoice link works from the moment it is minted. Flip point
 * for "the link lasts 30 days": links already sent keep the `expiraEn` stored
 * on their row, so changing this moves only new ones.
 */
export const VIGENCIA_ENLACE_FACTURA_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a link row is kept AFTER it expires (TTL index). The row carries the
 * usage counters a later package reads, so it must outlive the link.
 */
export const RETENCION_TRAS_VENCER_S = 90 * 24 * 60 * 60;

/**
 * What a link to a VOIDED invoice does. Flip point for "voided invoices are
 * refused": `'estampar'` lets the single-page PDF builder stamp ANULADA, which
 * it already does for the resident portal.
 */
export function decisionAnulada(): 'rechazar' | 'estampar' {
  return 'rechazar';
}

/** The ONE message of every refusal of the public route, whatever the cause. */
export const MENSAJE_OPACO = 'El enlace no es válido o ya no está disponible';

/** A refusal never answers before this long, so timing does not tell the stage. */
export const PISO_DE_TIEMPO_MS = 300;

/** A well-formed token: 32 random bytes in lowercase hex. */
export const FORMATO_TOKEN = /^[0-9a-f]{64}$/;

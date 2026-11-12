// src/common/firebase/uid-residente.ts
import { claveCorreo } from '../utils/email.utils';

/** Prefix of every self-service resident identity (version 1 of the scheme). */
export const PREFIJO_UID_RESIDENTE = 'rc1_';

/** The only shape `crearIdentidadResidente` accepts: prefix + SHA-256 hex. */
export const UID_RESIDENTE_REGEX = /^rc1_[0-9a-f]{64}$/;

/**
 * The provider uid of a resident who signs in by e-mail link: the prefix plus
 * `claveCorreo(address)`. Deterministic, so a retry or a race lands on the same
 * identity instead of making a second one, and it carries no part of the
 * address (it is the same pseudonym every stored record already uses).
 */
export function uidDeResidente(correo: string): string {
  return `${PREFIJO_UID_RESIDENTE}${claveCorreo(correo)}`;
}

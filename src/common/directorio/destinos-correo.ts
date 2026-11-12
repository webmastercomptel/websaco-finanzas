// src/common/directorio/destinos-correo.ts
import type { Types } from 'mongoose';
import {
  claveCorreo,
  esEmailValido,
  normalizarEmail,
} from '../utils/email.utils';

/** Which side of a unit an address belongs to. Same words as `RolEnInmueble`. */
export type RolDestino = 'propietario' | 'arrendatario';

/**
 * Who receives an invoice, in delivery order (the owner first, so an address
 * on both parties is attributed to the owner). Flip point for "the tenant also
 * receives": drop `'arrendatario'` here and both the send and the use-time
 * check of the public link follow, because they read this same constant.
 */
export const ROLES_QUE_RECIBEN: readonly RolDestino[] = [
  'propietario',
  'arrendatario',
] as const;

/** One address an invoice of a unit is sent to. `email` is the stored
 *  spelling, trimmed; `clave` is its identity everywhere else. */
export interface DestinoCorreo {
  clave: string;
  email: string;
  rol: RolDestino;
  terceroId: Types.ObjectId;
  nombre: string;
}

/** The part of a `Tercero` the resolver reads. */
export interface ParteConCorreos {
  _id: Types.ObjectId;
  nombre: string;
  emails?: string[] | null;
}

/**
 * The addresses an invoice of a unit goes to, computed from the RECORDS of its
 * two parties, never from accounts.
 *
 * Pure on purpose: the processor (send time) and the public link service (use
 * time) call this very function, so they cannot disagree about who a
 * recipient is. Rules: owner first, then tenant; blank or malformed entries
 * are skipped and never block the valid ones; an address on both parties (any
 * case, any padding) is ONE entry, attributed to the owner. It does NOT cap
 * the list: the 5-address limit is enforced when addresses are written, and a
 * legacy list above it is read whole.
 *
 * `roles` defaults to `ROLES_QUE_RECIBEN`; the parameter exists so the flip
 * point can be tested.
 */
export function destinosDeUnidad(
  titular: ParteConCorreos | null | undefined,
  arrendatario: ParteConCorreos | null | undefined,
  roles: readonly RolDestino[] = ROLES_QUE_RECIBEN,
): DestinoCorreo[] {
  const partes: Record<RolDestino, ParteConCorreos | null | undefined> = {
    propietario: titular,
    arrendatario,
  };
  const vistos = new Set<string>();
  const destinos: DestinoCorreo[] = [];

  for (const rol of roles) {
    const parte = partes[rol];
    if (!parte) continue;
    for (const crudo of parte.emails ?? []) {
      const email = crudo.trim();
      if (!esEmailValido(email)) continue;
      const clave = claveCorreo(normalizarEmail(email));
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      destinos.push({
        clave,
        email,
        rol,
        terceroId: parte._id,
        nombre: parte.nombre,
      });
    }
  }
  return destinos;
}

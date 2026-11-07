// src/modules/acceso-residentes/acceso-residentes.mapper.ts
import type {
  EstadoAccesoResidente,
  ResidenteAcceso,
  UnidadDeResidente,
} from '../../contracts';
import { esEmailValido } from '../../common/utils/email.utils';

/**
 * The address an invitation goes to: the FIRST valid one of the party's list,
 * trimmed and lowercased (accounts store emails lowercased). A party often has
 * several inboxes (owner and property manager); picking the first keeps the
 * choice predictable and lets the administrator control it by ordering the list
 * in Terceros. Null when none is usable.
 */
export const correoDeInvitacion = (
  emails: readonly string[] | undefined,
): string | null => {
  for (const crudo of emails ?? []) {
    const correo = crudo.trim().toLowerCase();
    if (esEmailValido(correo)) return correo;
  }
  return null;
};

/** The slice of a Tercero this module reads. */
export interface TerceroResidente {
  _id: { toString(): string };
  nombre: string;
  emails?: string[];
  accountId?: { toString(): string } | null;
}

/**
 * Maps a party to the contract. `accountId` never leaves: the screen learns
 * whether a sign-in exists, not which account it is.
 */
export const toResidenteAcceso = (
  tercero: TerceroResidente,
  unidades: UnidadDeResidente[],
  cuentaActiva: boolean | null,
): ResidenteAcceso => {
  const email = correoDeInvitacion(tercero.emails);
  const tieneCuenta = tercero.accountId != null;
  const estadoAcceso: EstadoAccesoResidente = !tieneCuenta
    ? 'sinCuenta'
    : cuentaActiva === false
      ? 'cuentaInactiva'
      : 'conCuenta';
  return {
    terceroId: tercero._id.toString(),
    nombre: tercero.nombre,
    email,
    estadoAcceso,
    unidades,
    aprovisionable: !tieneCuenta && email !== null,
  };
};

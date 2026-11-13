// src/common/acceso/residencia.reglas.ts
import { claveCorreo, normalizarEmail } from '../utils/email.utils';

/**
 * Pure rules of the address-derived resident access. Nothing here reads a
 * database: `ResidenciaService` fetches, these functions decide. The owner
 * assumptions that may flip are each ONE constant or ONE function below.
 */

/**
 * FLIP POINT A3 (owner assumption 3): does revoking the portal of an address
 * also stop the invoice e-mails to it? NO today: invoice recipients are the
 * addresses on the records (`destinosDeUnidad`, `correosDeInmuebles`) and a
 * pin test keeps them ignoring revocations while this is false. To flip it,
 * add ONE filter in `DirectorioService.correosDeInmuebles` that drops the
 * addresses with an active revocation for the unit's coproperty
 * (`ResidenciaService.revocacionesActivas`), then set this to true and
 * update the pin.
 */
export const REVOCACION_DETIENE_CORREOS_FACTURA = false;

/**
 * Recheck of a collation candidate: the `emails_ci` index (en, strength 2)
 * finds addresses that are equal ignoring case, but it may also equate strings
 * that are different addresses (ligatures such as the German sharp s). The
 * stored value must equal the normalized address EXACTLY once lowercased.
 *
 * A legacy value stored WITH padding does not match: writes are trimmed
 * from now on (element setter on `Tercero.emails`), and an old padded value
 * starts matching only after its party is saved again. Residentes marks it
 * `requiereCorreccion`.
 */
export function coincideCorreo(almacenado: string, correo: string): boolean {
  if (almacenado.length === 0 || almacenado !== almacenado.trim()) {
    return false;
  }
  return almacenado.toLowerCase() === normalizarEmail(correo);
}

/** A holder record as the rules see it: ids as strings. */
export interface TerceroEnReglas {
  id: string;
  copropiedadId: string;
}

/** A unit as the rules see it: ids as strings. */
export interface InmuebleEnReglas {
  id: string;
  copropiedadId: string;
  titularId: string | null;
  arrendatarioId: string | null;
}

export interface UnidadDeResidencia {
  inmuebleId: string;
  copropiedadId: string;
  rol: 'propietario' | 'arrendatario';
}

/**
 * FLIP POINT A1 (owner assumption 1, units side): the units held by a set of
 * party records. A unit is returned ONCE; `propietario` wins over
 * `arrendatario` when the set holds both sides. A party only counts for a unit
 * of its OWN coproperty: a unit whose `titularId`/`arrendatarioId` points at a
 * party of another coproperty grants nothing (the same rule the legacy path
 * has always applied). Output keeps the order of `inmuebles`.
 */
export function unidadesDeTerceros(
  terceros: readonly TerceroEnReglas[],
  inmuebles: readonly InmuebleEnReglas[],
): UnidadDeResidencia[] {
  const coproDe = new Map(terceros.map((t) => [t.id, t.copropiedadId]));
  const cuenta = (parteId: string | null, copropiedadId: string): boolean =>
    parteId !== null && coproDe.get(parteId) === copropiedadId;

  const resultado: UnidadDeResidencia[] = [];
  for (const unidad of inmuebles) {
    if (cuenta(unidad.titularId, unidad.copropiedadId)) {
      resultado.push({
        inmuebleId: unidad.id,
        copropiedadId: unidad.copropiedadId,
        rol: 'propietario',
      });
    } else if (cuenta(unidad.arrendatarioId, unidad.copropiedadId)) {
      resultado.push({
        inmuebleId: unidad.id,
        copropiedadId: unidad.copropiedadId,
        rol: 'arrendatario',
      });
    }
  }
  return resultado;
}

/**
 * FLIP POINT A2 (owner assumption 2): does a revocation apply to this
 * coproperty? Today per (coproperty, address): only an ACTIVE row of the same
 * coproperty counts. To make it "per person, everywhere", ignore
 * `copropiedadId` here.
 */
export function revocacionAplica(
  revocacion: { copropiedadId: string; activa: boolean },
  copropiedadId: string,
): boolean {
  return revocacion.activa && revocacion.copropiedadId === copropiedadId;
}

/**
 * FLIP POINT A1 (owner assumption 1, licence side): entry is open in any
 * coproperty that contracted at least one module. Takes the EFFECTIVE modules
 * (`modulosEfectivos`: a legacy document reads as Finanzas). Residentes
 * visibility is the decorator on its routes plus the navigation list.
 */
export function copropiedadAdmiteIngresoResidentes(
  modulos: readonly string[],
): boolean {
  return modulos.includes('finanzas') || modulos.includes('administracion');
}

/**
 * FLIP POINT A5 (decided without the owner, conservative): the cap of DISTINCT
 * active party records, across all coproperties, that may carry one address
 * before it is treated as a shared inbox (an administration or concierge
 * mailbox typed by staff on many records). Above it the address grants no
 * address-derived residency anywhere and gets no sign-in link. A person with
 * one record holding many units counts as ONE.
 */
export const MAX_TERCEROS_POR_CORREO = 3;

/**
 * Why an address must not derive residency (`requiereCorreccion` reason code
 * of the Residentes listing): it is on too many party records. Being the
 * address of a staff Account is NOT a reason: staff and resident access add up
 * (owner's decision), so a staff member who owns or rents a unit keeps both.
 */
export type MotivoCorreoGenerico = 'correo-compartido';

/**
 * FLIP POINT A5: is this address a generic inbox? The ONE rule behind
 * `ResidenciaService.tercerosPorCorreo` (and through it every address-derived
 * residency: `AccesoService`, `PortalAccesoService`, the sign-in request and
 * redeem) and `ResidenciaService.motivosCorreoGenerico` (`DirectorioService`,
 * the Residentes listing), so the gate and the listing never disagree.
 * Only the count of distinct active parties decides: whether the address
 * belongs to staff is deliberately not a fact here (staff and resident access
 * add up; whether staff gets a passwordless SESSION is the separate link
 * policy, `common/cuentas/politica-enlace.ts`). The legacy
 * `Tercero.accountId` link is not judged here and keeps working. To relax it,
 * raise the cap here, nowhere else.
 */
export function motivoCorreoGenerico(hechos: {
  tercerosDistintos: number;
}): MotivoCorreoGenerico | null {
  if (hechos.tercerosDistintos > MAX_TERCEROS_POR_CORREO) {
    return 'correo-compartido';
  }
  return null;
}

/**
 * Does the Account currently prove the address it carries? Only when the proof
 * (`correoProbadoClave`, set by a redeemed sign-in link) is for the Account's
 * CURRENT address and the account is active: a proof for another `clave` (the
 * address changed afterwards) grants nothing, and an address on a record is
 * never enough on its own. `estado` is optional for callers that already
 * refused an inactive account.
 */
export function correoProbado(cuenta: {
  email: string;
  estado?: string;
  correoProbadoClave?: string | null;
}): boolean {
  if (cuenta.estado !== undefined && cuenta.estado !== 'active') return false;
  return (
    !!cuenta.correoProbadoClave &&
    cuenta.correoProbadoClave === claveCorreo(cuenta.email)
  );
}

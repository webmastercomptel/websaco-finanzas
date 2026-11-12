// src/common/acceso/residencia.reglas.ts
import { normalizarEmail } from '../utils/email.utils';

/**
 * Pure rules of the address-derived resident access. Nothing here reads a
 * database: `ResidenciaService` fetches, these functions decide. The four
 * owner assumptions that may flip are each ONE constant or ONE function below.
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

// src/modules/facturacion-bloque/facturacion-bloque-acceso.ts
import type { TipoBloque } from '../../database/schemas/administracion/bloque-facturacion.schema';

/** How a resident holds one unit; the role decides which kinds they may see. */
export type RolBloque = 'propietario' | 'arrendatario';

/**
 * What each role may read of a block, per unit. This is the product rule, kept
 * in ONE place so the recipients of a send and the documents a resident can list
 * or download can never disagree:
 *
 * - the OWNER sees invoices AND statements of account;
 * - the TENANT sees invoices only (a statement is the owner's cartera);
 * - NOBODY who is a resident ever sees a receipt (`recibo`): it is a staff
 *   record, as in the native Finanzas portal.
 */
const TIPOS_POR_ROL: Record<RolBloque, readonly TipoBloque[]> = {
  propietario: ['factura', 'estado_cuenta'],
  arrendatario: ['factura'],
};

/** Kinds a resident can ever be offered (the filter values of the portal list). */
export const TIPOS_DE_RESIDENTE = ['factura', 'estado_cuenta'] as const;

/** Whether `rol` may read a document of kind `tipo`. */
export const puedeVerTipo = (rol: RolBloque, tipo: TipoBloque): boolean =>
  TIPOS_POR_ROL[rol].includes(tipo);

/** Whether a block of this kind is ever sent to residents. */
export const esTipoEnviable = (tipo: TipoBloque): boolean =>
  TIPOS_POR_ROL.propietario.includes(tipo) ||
  TIPOS_POR_ROL.arrendatario.includes(tipo);

// src/common/licencia/modulos.ts

/** Product modules a coproperty can contract. */
export const MODULOS_PRODUCTO = ['finanzas', 'administracion'] as const;
export type ModuloProducto = (typeof MODULOS_PRODUCTO)[number];

/**
 * The modules a coproperty has contracted. Documents created before the field
 * existed have none stored: they are Finanzas customers by definition (it is
 * the product that existed), so a missing or empty list means `['finanzas']`.
 * Unknown values are dropped rather than trusted.
 *
 * This is the commercial entitlement, not the security boundary: permissions
 * still decide what a person may do inside a contracted module.
 */
export function modulosEfectivos(
  copropiedad: { modulosContratados?: readonly string[] | null } | null,
): ModuloProducto[] {
  const guardados = (copropiedad?.modulosContratados ?? []).filter(
    (m): m is ModuloProducto =>
      (MODULOS_PRODUCTO as readonly string[]).includes(m),
  );
  return guardados.length > 0 ? [...new Set(guardados)] : ['finanzas'];
}

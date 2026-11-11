// src/modules/casl/filtro-lista-exacta.ts

/**
 * Mongo condition for "this array field is still exactly what I read": array
 * equality (same elements, same order) for a non-empty list, and
 * "absent or empty" for an empty one, because legacy rows may lack the field
 * and `{ campo: [] }` would not match them.
 *
 * The conditional write behind the delegation cap: `/equipo` (keys and roles of
 * a member) and `/roles` (keys of a role) apply a change only while the list
 * the cap judged is still the stored one, so a concurrent change makes the
 * write match nothing (a 409) instead of being silently overwritten. Returned
 * as a single condition so two of them can sit side by side under `$and`, which
 * two `$or` keys could not.
 */
export const filtroListaExacta = (
  campo: string,
  lista: readonly unknown[],
): Record<string, unknown> =>
  lista.length > 0
    ? { [campo]: [...lista] }
    : { $or: [{ [campo]: { $exists: false } }, { [campo]: { $size: 0 } }] };

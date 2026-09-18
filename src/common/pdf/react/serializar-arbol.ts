import { isValidElement } from 'react';
import { CreditoWebsaco } from './credito-websaco';

export type NodoSerializado =
  string | number | null | { type: string; props: Record<string, unknown> };

/**
 * Resolves a react-pdf element tree down to plain JSON.
 *
 * `@react-pdf/renderer`'s own primitives (`View`/`Text`/`Document`/...) are
 * already plain strings under the hood (`@react-pdf/primitives`,
 * e.g. `const View = 'VIEW'`), and `StyleSheet.create` is the identity
 * function — so once every one of THIS codebase's own components
 * (`CuerpoFactura`, `DatosAdquiriente`, etc. — pure functions, no hooks) is
 * resolved by calling it, what's left is nothing but
 * `{ type: string, props: object }` nodes: 100% serializable, and
 * renderable again later by a generic (browser-side) interpreter that has
 * never heard of a Factura.
 *
 * `CreditoWebsaco` is dropped on purpose wherever it appears in the tree —
 * the frontend draws its own footer with its own logo asset, so the same
 * PNG bytes don't get persisted on every single invoice.
 */
export function serializarArbol(
  el: unknown,
): NodoSerializado | NodoSerializado[] {
  if (el === null || el === undefined || typeof el === 'boolean') return null;
  if (typeof el === 'string' || typeof el === 'number') return el;
  if (Array.isArray(el)) {
    return el
      .map(serializarArbol)
      .filter((n): n is NodoSerializado => n !== null);
  }
  if (!isValidElement(el)) return null;

  const { type, props } = el as {
    type: unknown;
    props: Record<string, unknown>;
  };
  if (type === CreditoWebsaco) return null;
  if (typeof type === 'function') {
    return serializarArbol((type as (p: unknown) => unknown)(props));
  }
  if (typeof type !== 'string') {
    // A Fragment (`type` is a Symbol) or a memo/forwardRef component
    // (`type` is an object) — this codebase's `common/pdf/react/*` tree
    // never uses either today (plain function components only), but if one
    // ever creeps in, failing loudly here beats silently freezing a
    // corrupted node into a legal document with no `type` to render.
    throw new Error(
      `serializarArbol: nodo de tipo no soportado (${typeof type}) — solo primitivos de react-pdf o componentes función.`,
    );
  }

  const { children, ...resto } = props;
  return {
    type,
    props: { ...resto, hijos: serializarArbol(children) },
  };
}

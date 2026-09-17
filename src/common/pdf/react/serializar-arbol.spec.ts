import { createElement } from 'react';

// `@react-pdf/renderer` ships as ESM, which Jest's CJS test environment
// can't load (`Must use import to load ES Module` — the same pre-existing
// gap that already disables 6 other suites in this repo, e.g.
// `recibos.controller.spec.ts` via `recibo-pdf.ts`). `serializar-arbol.ts`
// pulls it in transitively via `credito-websaco.ts`, so mocking it here is
// the only way this suite can load at all. Values match the real library
// exactly (`View`/`Text`/... are plain strings — `@react-pdf/primitives`;
// `StyleSheet.create` is the identity function — both verified against the
// installed package this session), so this isn't a fake shortcut, it's a
// faithful stand-in for a module Jest can't evaluate directly.
jest.mock('@react-pdf/renderer', () => ({
  View: 'VIEW',
  Text: 'TEXT',
  Image: 'IMAGE',
  Document: 'DOCUMENT',
  Page: 'PAGE',
  StyleSheet: { create: (s: unknown) => s },
}));

import { Text, View } from '@react-pdf/renderer';
import { serializarArbol } from './serializar-arbol';
import { CreditoWebsaco } from './credito-websaco';

describe('serializarArbol', () => {
  it('convierte un primitivo de react-pdf a un nodo { type, props }', () => {
    expect(serializarArbol(createElement(Text, null, 'hola'))).toEqual({
      type: 'TEXT',
      props: { hijos: 'hola' },
    });
  });

  it('resuelve un componente propio (función pura, sin hooks) llamándolo', () => {
    function Saludo(props: { nombre: string }) {
      return createElement(Text, null, `Hola ${props.nombre}`);
    }

    expect(serializarArbol(createElement(Saludo, { nombre: 'Ana' }))).toEqual({
      type: 'TEXT',
      props: { hijos: 'Hola Ana' },
    });
  });

  it('preserva las props propias del elemento junto con sus hijos serializados', () => {
    const nodo = serializarArbol(
      createElement(
        View,
        { style: { marginTop: 4 } },
        createElement(Text, null, 'x'),
      ),
    );
    expect(nodo).toEqual({
      type: 'VIEW',
      props: {
        style: { marginTop: 4 },
        hijos: { type: 'TEXT', props: { hijos: 'x' } },
      },
    });
  });

  it('descarta hijos null/false/undefined', () => {
    const nodo = serializarArbol(
      createElement(
        View,
        null,
        null,
        false,
        undefined,
        createElement(Text, null, 'y'),
      ),
    );
    expect(nodo).toEqual({
      type: 'VIEW',
      props: { hijos: [{ type: 'TEXT', props: { hijos: 'y' } }] },
    });
  });

  it('omite CreditoWebsaco en cualquier punto del árbol', () => {
    expect(serializarArbol(createElement(CreditoWebsaco))).toBeNull();

    const nodo = serializarArbol(
      createElement(
        View,
        null,
        createElement(Text, null, 'z'),
        createElement(CreditoWebsaco),
      ),
    );
    expect(nodo).toEqual({
      type: 'VIEW',
      props: { hijos: [{ type: 'TEXT', props: { hijos: 'z' } }] },
    });
  });
});

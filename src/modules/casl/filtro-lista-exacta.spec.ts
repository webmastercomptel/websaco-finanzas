import { filtroListaExacta } from './filtro-lista-exacta';

describe('filtroListaExacta', () => {
  it('una lista con elementos se compara por igualdad exacta, en el mismo orden', () => {
    expect(filtroListaExacta('permisos', ['b', 'a'])).toEqual({
      permisos: ['b', 'a'],
    });
  });

  it('copia la lista: cambiarla después no altera el filtro', () => {
    const lista = ['a'];
    const filtro = filtroListaExacta('permisos', lista);
    lista.push('b');

    expect(filtro).toEqual({ permisos: ['a'] });
  });

  it('una lista vacía casa con el campo ausente O con un arreglo vacío (filas heredadas sin el campo)', () => {
    expect(filtroListaExacta('roleIds', [])).toEqual({
      $or: [{ roleIds: { $exists: false } }, { roleIds: { $size: 0 } }],
    });
  });

  it('dos filtros caben bajo $and sin pisarse (dos listas vacías usan $or cada una)', () => {
    const condicion = {
      $and: [
        filtroListaExacta('permisos', []),
        filtroListaExacta('roleIds', []),
      ],
    };

    expect(condicion.$and).toHaveLength(2);
    expect(condicion.$and[0]).not.toBe(condicion.$and[1]);
  });
});

import {
  accesoDelPersonal,
  aclsEfectivos,
  aclsHeredados,
  residentePuedeLeer,
  type ActorDocumentos,
  type EntradaAcl,
  type NodoCarpeta,
  type TipoResidente,
} from './documentos-acceso';

const rol = (
  rolId: string,
  puedeLeer: boolean,
  puedeEscribir: boolean,
): EntradaAcl => ({ tipo: 'rol', rolId, puedeLeer, puedeEscribir });

const residentes = (
  r: 'propietario' | 'arrendatario' | 'todos',
  puedeLeer = true,
): EntradaAcl => ({
  tipo: 'residentes',
  rol: r,
  puedeLeer,
  puedeEscribir: false,
});

const carpeta = (
  id: string,
  padre: string | null,
  acls: EntradaAcl[] = [],
): NodoCarpeta => ({ _id: id, carpetaPadreId: padre, acls });

const mapaDe = (...cs: NodoCarpeta[]): ReadonlyMap<string, NodoCarpeta> =>
  new Map(cs.map((c) => [c._id.toString(), c]));

const actor = (roles: string[], gestiona = false): ActorDocumentos => ({
  roleIds: new Set(roles),
  gestiona,
});

const tipos = (...t: TipoResidente[]): ReadonlySet<TipoResidente> => new Set(t);

describe('accesoDelPersonal', () => {
  const RECEPCION = 'rol-recepcion';
  const CONSEJO = 'rol-consejo';
  const OTRO = 'rol-otro';

  it('quien gestiona tiene acceso total sin importar las reglas', () => {
    const f = carpeta('a', null, [rol(RECEPCION, true, false)]);
    expect(accesoDelPersonal(f, actor([], true), mapaDe(f))).toEqual({
      puedeLeer: true,
      puedeEscribir: true,
      puedeAdministrar: true,
    });
  });

  it('una carpeta sin reglas en toda su cadena es privada, no pública', () => {
    const f = carpeta('a', null);
    expect(accesoDelPersonal(f, actor([OTRO]), mapaDe(f))).toEqual({
      puedeLeer: false,
      puedeEscribir: false,
      puedeAdministrar: false,
    });
  });

  it('refleja las banderas de la regla del rol y nunca concede administrar', () => {
    const f = carpeta('a', null, [rol(RECEPCION, true, true)]);
    expect(accesoDelPersonal(f, actor([RECEPCION]), mapaDe(f))).toEqual({
      puedeLeer: true,
      puedeEscribir: true,
      puedeAdministrar: false,
    });
  });

  it('une los permisos de todos los roles del usuario', () => {
    const f = carpeta('a', null, [
      rol(CONSEJO, true, true),
      rol(RECEPCION, true, false),
    ]);
    expect(
      accesoDelPersonal(f, actor([RECEPCION, CONSEJO]), mapaDe(f)),
    ).toMatchObject({ puedeLeer: true, puedeEscribir: true });
    expect(accesoDelPersonal(f, actor([RECEPCION]), mapaDe(f))).toMatchObject({
      puedeLeer: true,
      puedeEscribir: false,
    });
  });

  it('niega todo si ninguno de sus roles está en la carpeta restringida', () => {
    const f = carpeta('a', null, [rol(RECEPCION, true, true)]);
    expect(accesoDelPersonal(f, actor([OTRO, CONSEJO]), mapaDe(f))).toEqual({
      puedeLeer: false,
      puedeEscribir: false,
      puedeAdministrar: false,
    });
  });

  it('una regla de residentes no da acceso al personal aunque coincida el id', () => {
    const f = carpeta('a', null, [residentes('todos')]);
    expect(accesoDelPersonal(f, actor([RECEPCION]), mapaDe(f)).puedeLeer).toBe(
      false,
    );
  });

  it('hereda las reglas del ancestro más cercano si la carpeta no define ninguna', () => {
    const padre = carpeta('padre', null, [rol(RECEPCION, true, false)]);
    const hija = carpeta('hija', 'padre');
    const mapa = mapaDe(padre, hija);
    expect(accesoDelPersonal(hija, actor([RECEPCION]), mapa).puedeLeer).toBe(
      true,
    );
    expect(accesoDelPersonal(hija, actor([OTRO]), mapa).puedeLeer).toBe(false);
  });

  it('las reglas propias de la carpeta reemplazan por completo las del ancestro', () => {
    const padre = carpeta('padre', null, [rol(RECEPCION, true, true)]);
    const hija = carpeta('hija', 'padre', [rol(CONSEJO, true, false)]);
    const mapa = mapaDe(padre, hija);
    expect(accesoDelPersonal(hija, actor([CONSEJO]), mapa).puedeLeer).toBe(
      true,
    );
    expect(accesoDelPersonal(hija, actor([RECEPCION]), mapa).puedeLeer).toBe(
      false,
    );
  });

  it('un enlace roto al padre corta la cadena y la carpeta queda privada', () => {
    const huerfana = carpeta('hija', 'no-existe');
    expect(aclsEfectivos(huerfana, mapaDe(huerfana))).toEqual([]);
  });

  it('un ciclo en la jerarquía no cuelga la resolución', () => {
    const a = carpeta('a', 'b');
    const b = carpeta('b', 'a');
    expect(aclsEfectivos(a, mapaDe(a, b))).toEqual([]);
  });
});

describe('aclsHeredados', () => {
  it('devuelve las reglas del ancestro y su id, ignorando las propias', () => {
    const abuelo = carpeta('abuelo', null, [rol('r', true, false)]);
    const padre = carpeta('padre', 'abuelo');
    const hija = carpeta('hija', 'padre', [rol('otra', true, true)]);
    const { acls, origenId } = aclsHeredados(hija, mapaDe(abuelo, padre, hija));
    expect(origenId).toBe('abuelo');
    expect(acls).toEqual([rol('r', true, false)]);
  });

  it('vacío y sin origen cuando ningún ancestro define reglas', () => {
    const f = carpeta('a', null);
    expect(aclsHeredados(f, mapaDe(f))).toEqual({ acls: [], origenId: null });
  });
});

describe('residentePuedeLeer', () => {
  it('un propietario ve la carpeta que lista a propietarios y un arrendatario no', () => {
    const f = carpeta('a', null, [residentes('propietario')]);
    const mapa = mapaDe(f);
    expect(residentePuedeLeer(f, tipos('propietario'), mapa)).toBe(true);
    expect(residentePuedeLeer(f, tipos('arrendatario'), mapa)).toBe(false);
  });

  it('un arrendatario ve la carpeta que lista a arrendatarios', () => {
    const f = carpeta('a', null, [residentes('arrendatario')]);
    expect(residentePuedeLeer(f, tipos('arrendatario'), mapaDe(f))).toBe(true);
  });

  it('"todos" alcanza a propietarios y arrendatarios, pero no a quien no tiene unidades', () => {
    const f = carpeta('a', null, [residentes('todos')]);
    const mapa = mapaDe(f);
    expect(residentePuedeLeer(f, tipos('propietario'), mapa)).toBe(true);
    expect(residentePuedeLeer(f, tipos('arrendatario'), mapa)).toBe(true);
    expect(residentePuedeLeer(f, tipos(), mapa)).toBe(false);
  });

  it('quien es propietario de una unidad y arrendatario de otra ve lo de ambas audiencias', () => {
    const f = carpeta('a', null, [residentes('arrendatario')]);
    expect(
      residentePuedeLeer(f, tipos('propietario', 'arrendatario'), mapaDe(f)),
    ).toBe(true);
  });

  it('una carpeta solo con reglas de roles o sin reglas es invisible para residentes', () => {
    const conRoles = carpeta('a', null, [rol('r', true, true)]);
    const sinReglas = carpeta('b', null);
    expect(
      residentePuedeLeer(conRoles, tipos('propietario'), mapaDe(conRoles)),
    ).toBe(false);
    expect(
      residentePuedeLeer(sinReglas, tipos('propietario'), mapaDe(sinReglas)),
    ).toBe(false);
  });

  it('una regla de residentes sin puedeLeer no deja ver', () => {
    const f = carpeta('a', null, [residentes('todos', false)]);
    expect(residentePuedeLeer(f, tipos('propietario'), mapaDe(f))).toBe(false);
  });

  it('hereda la visibilidad del ancestro y la pierde si la carpeta define sus propias reglas', () => {
    const padre = carpeta('padre', null, [residentes('todos')]);
    const heredera = carpeta('heredera', 'padre');
    const propia = carpeta('propia', 'padre', [rol('r', true, false)]);
    const mapa = mapaDe(padre, heredera, propia);
    expect(residentePuedeLeer(heredera, tipos('propietario'), mapa)).toBe(true);
    expect(residentePuedeLeer(propia, tipos('propietario'), mapa)).toBe(false);
  });
});

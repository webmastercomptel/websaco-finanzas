import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  clavesEfectivas,
  clavesFueraDeAlcance,
  cambioDeClaves,
  esClaveOfrecida,
  exigirClavesConocidas,
  exigirDelegacion,
  type Delegante,
} from './delegacion';
import {
  PERMISOS_ADMINISTRACION,
  PERMISOS_FINANZAS,
} from './permisos-catalogo';

const ana: Delegante = { permissions: ['facturas.ver', 'tareas.ver'] };
const admin: Delegante = { isPlatformAdmin: true, permissions: [] };

/** Runs `fn` and returns what it threw, so a test can inspect the message. */
const lanzado = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('esClaveOfrecida', () => {
  it('ofrece exactamente el catálogo de Finanzas más el de Administración (86)', () => {
    const todas = [
      ...PERMISOS_FINANZAS,
      ...PERMISOS_ADMINISTRACION.map((p) => p.id),
    ];

    expect(todas).toHaveLength(86);
    for (const clave of todas) expect(esClaveOfrecida(clave)).toBe(true);
  });

  it('no ofrece una clave de Finanzas que la gramática admite pero ninguna ruta pide', () => {
    expect(esClaveOfrecida('inmuebles.aprobar')).toBe(false);
  });

  it('no ofrece un `gestionar` de Finanzas (ya no es una clave)', () => {
    expect(esClaveOfrecida('facturas.gestionar')).toBe(false);
  });

  it('sí ofrece los `gestionar` de Administración del catálogo', () => {
    expect(esClaveOfrecida('tareas.gestionar')).toBe(true);
    expect(esClaveOfrecida('roles.gestionar')).toBe(true);
  });

  it('no ofrece claves inventadas ni mal formadas', () => {
    for (const clave of [
      'tareas.volar',
      'inventada.ver',
      'basura',
      '',
      'a.b.c',
    ]) {
      expect(esClaveOfrecida(clave)).toBe(false);
    }
  });

  it('no ofrece una clave de Administración que la gramática admite pero el catálogo no (pqr.depurar)', () => {
    expect(esClaveOfrecida('pqr.depurar')).toBe(false);
    expect(esClaveOfrecida('usuarios.gestionar')).toBe(false);
  });
});

describe('clavesEfectivas', () => {
  it('une las listas sin duplicados', () => {
    expect(
      clavesEfectivas(
        ['facturas.ver', 'tareas.ver'],
        ['tareas.ver', 'pqr.ver'],
      ),
    ).toEqual(['facturas.ver', 'tareas.ver', 'pqr.ver']);
  });

  it('descarta las claves no ofrecidas y las desconocidas', () => {
    expect(
      clavesEfectivas([
        'facturas.ver',
        'facturas.gestionar',
        'inmuebles.aprobar',
        'tareas.volar',
        'inventada.ver',
      ]),
    ).toEqual(['facturas.ver']);
  });

  it('sin listas, o con listas vacías, devuelve vacío', () => {
    expect(clavesEfectivas()).toEqual([]);
    expect(clavesEfectivas([], [])).toEqual([]);
  });
});

describe('cambioDeClaves', () => {
  it('devuelve la diferencia simétrica: lo agregado y lo quitado', () => {
    expect(
      cambioDeClaves(['facturas.ver', 'tareas.ver'], ['tareas.ver', 'pqr.ver']),
    ).toEqual({ agregadas: ['pqr.ver'], quitadas: ['facturas.ver'] });
  });

  it('ordena ambas listas de forma ascendente', () => {
    expect(
      cambioDeClaves(
        ['tareas.ver', 'pqr.ver'],
        ['recibos.ver', 'facturas.ver'],
      ),
    ).toEqual({
      agregadas: ['facturas.ver', 'recibos.ver'],
      quitadas: ['pqr.ver', 'tareas.ver'],
    });
  });

  it('una clave presente antes y después no cuenta, esté donde esté', () => {
    expect(
      cambioDeClaves(
        ['facturas.ver', 'tareas.ver'],
        ['tareas.ver', 'facturas.ver'],
      ),
    ).toEqual({ agregadas: [], quitadas: [] });
  });

  it('es simétrica: invertir antes y después intercambia las listas', () => {
    const antes = ['facturas.ver'];
    const despues = ['pqr.ver', 'tareas.ver'];

    const ida = cambioDeClaves(antes, despues);
    const vuelta = cambioDeClaves(despues, antes);

    expect(vuelta.agregadas).toEqual(ida.quitadas);
    expect(vuelta.quitadas).toEqual(ida.agregadas);
  });

  it('cuenta solo claves ofrecidas: una clave heredada no ofrecida no aparece', () => {
    expect(
      cambioDeClaves(
        ['facturas.gestionar', 'inmuebles.aprobar', 'facturas.ver'],
        ['facturas.ver'],
      ),
    ).toEqual({ agregadas: [], quitadas: [] });
    expect(cambioDeClaves([], ['facturas.gestionar', 'tareas.volar'])).toEqual({
      agregadas: [],
      quitadas: [],
    });
  });

  it('no repite una clave duplicada en la entrada', () => {
    expect(cambioDeClaves([], ['pqr.ver', 'pqr.ver'])).toEqual({
      agregadas: ['pqr.ver'],
      quitadas: [],
    });
  });
});

describe('clavesFueraDeAlcance', () => {
  it('es vacío para el administrador de plataforma, aunque no tenga claves', () => {
    expect(
      clavesFueraDeAlcance(admin, {
        agregadas: ['facturas.anular'],
        quitadas: ['pqr.ver'],
      }),
    ).toEqual([]);
  });

  it('devuelve las claves cambiadas que el delegante no tiene, agregadas y quitadas', () => {
    expect(
      clavesFueraDeAlcance(ana, {
        agregadas: ['facturas.ver', 'facturas.anular'],
        quitadas: ['anuncios.ver', 'tareas.ver'],
      }),
    ).toEqual(['anuncios.ver', 'facturas.anular']);
  });

  it('compara la clave exacta: `tareas.gestionar` no da derecho a `tareas.ver`', () => {
    const conGestionar: Delegante = { permissions: ['tareas.gestionar'] };

    expect(
      clavesFueraDeAlcance(conGestionar, {
        agregadas: ['tareas.ver'],
        quitadas: [],
      }),
    ).toEqual(['tareas.ver']);
    expect(
      clavesFueraDeAlcance(conGestionar, {
        agregadas: ['tareas.gestionar'],
        quitadas: [],
      }),
    ).toEqual([]);
  });

  it('sin permisos declarados no tiene nada', () => {
    expect(
      clavesFueraDeAlcance({}, { agregadas: ['pqr.ver'], quitadas: [] }),
    ).toEqual(['pqr.ver']);
  });

  it('un cambio vacío nunca está fuera de alcance', () => {
    expect(clavesFueraDeAlcance({}, { agregadas: [], quitadas: [] })).toEqual(
      [],
    );
  });
});

describe('exigirDelegacion', () => {
  it('deja pasar un cambio sobre claves que se tienen y devuelve la diferencia', () => {
    expect(
      exigirDelegacion(ana, ['tareas.ver'], ['tareas.ver', 'facturas.ver']),
    ).toEqual({
      agregadas: ['facturas.ver'],
      quitadas: [],
    });
  });

  it('responde 403 cuando se agrega una clave que no se tiene (S-D2.2)', () => {
    const error = lanzado(() =>
      exigirDelegacion(ana, ['tareas.ver'], ['tareas.ver', 'facturas.anular']),
    );

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(
      'No puedes otorgar ni quitar permisos que no tienes: facturas.anular',
    );
  });

  it('responde 403 cuando se quita una clave que no se tiene (S-D2.3)', () => {
    const error = lanzado(() => exigirDelegacion(ana, ['anuncios.ver'], []));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toContain('anuncios.ver');
  });

  it('una clave que no cambia no se juzga, aunque no se tenga (S-D2.4)', () => {
    expect(
      exigirDelegacion(ana, ['anuncios.ver'], ['anuncios.ver', 'tareas.ver']),
    ).toEqual({ agregadas: ['tareas.ver'], quitadas: [] });
  });

  it('el mensaje nombra todas las claves infractoras, ordenadas (S-D2.9)', () => {
    const error = lanzado(() =>
      exigirDelegacion(ana, ['pqr.ver'], ['recibos.anular', 'facturas.anular']),
    );

    expect((error as ForbiddenException).message).toBe(
      'No puedes otorgar ni quitar permisos que no tienes: facturas.anular, pqr.ver, recibos.anular',
    );
  });

  it('acepta un mensaje propio (desactivar a alguien más rico)', () => {
    const error = lanzado(() =>
      exigirDelegacion(
        ana,
        ['facturas.anular'],
        [],
        'No puedes desactivar a alguien con permisos que tú no tienes',
      ),
    );

    expect((error as ForbiddenException).message).toBe(
      'No puedes desactivar a alguien con permisos que tú no tienes: facturas.anular',
    );
  });

  it('el administrador de plataforma queda exento aunque no tenga nada (S-D2.10)', () => {
    expect(exigirDelegacion(admin, ['pqr.ver'], ['facturas.anular'])).toEqual({
      agregadas: ['facturas.anular'],
      quitadas: ['pqr.ver'],
    });
  });

  it('`tareas.gestionar` no da derecho a dar `tareas.ver` (S-D2.5)', () => {
    const conGestionar: Delegante = { permissions: ['tareas.gestionar'] };

    expect(() => exigirDelegacion(conGestionar, [], ['tareas.ver'])).toThrow(
      ForbiddenException,
    );
  });

  it('en Finanzas la exactitud es plana: con ver y crear solo se dan ver y crear (S-D2.5)', () => {
    const conDos: Delegante = {
      permissions: ['facturas.ver', 'facturas.crear'],
    };

    expect(
      exigirDelegacion(conDos, [], ['facturas.ver', 'facturas.crear']),
    ).toEqual({ agregadas: ['facturas.crear', 'facturas.ver'], quitadas: [] });
    expect(() => exigirDelegacion(conDos, [], ['facturas.anular'])).toThrow(
      ForbiddenException,
    );
  });

  it('las claves no ofrecidas quedan fuera del tope: se pueden dejar o soltar sin tenerlas (S-D2.14)', () => {
    expect(
      exigirDelegacion({}, ['inmuebles.aprobar', 'facturas.gestionar'], []),
    ).toEqual({ agregadas: [], quitadas: [] });
  });

  it('no se crea nada de la nada: nadie reparte lo que no tiene (S-D7.1)', () => {
    const quien: Delegante = { permissions: ['facturas.ver'] };
    const ben: Delegante = { permissions: ['facturas.anular'] };

    // Ana cannot hand out Ben's key...
    expect(() => exigirDelegacion(quien, [], ['facturas.anular'])).toThrow(
      ForbiddenException,
    );
    // ...but can hand out her own, and Ben can hand out his.
    expect(exigirDelegacion(quien, [], ['facturas.ver']).agregadas).toEqual([
      'facturas.ver',
    ]);
    expect(exigirDelegacion(ben, [], ['facturas.anular']).agregadas).toEqual([
      'facturas.anular',
    ]);
  });
});

describe('exigirClavesConocidas', () => {
  it('acepta claves ofrecidas', () => {
    expect(() =>
      exigirClavesConocidas(['facturas.ver', 'tareas.gestionar']),
    ).not.toThrow();
  });

  it('responde 400 con el nombre de cada clave nueva que no se ofrece (S-D1.1, D1.3)', () => {
    const error = lanzado(() =>
      exigirClavesConocidas(['tareas.volar', 'pqr.eliminar', 'facturas.ver']),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      'Permisos que no existen: tareas.volar, pqr.eliminar',
    );
  });

  it('juzga solo despues menos antes: una clave heredada presente en ambas listas nunca lanza (S-D1.5)', () => {
    expect(() =>
      exigirClavesConocidas(
        ['facturas.gestionar', 'inmuebles.aprobar', 'facturas.ver'],
        ['facturas.gestionar', 'inmuebles.aprobar'],
      ),
    ).not.toThrow();
  });

  it('una clave heredada que se descarta tampoco lanza', () => {
    expect(() =>
      exigirClavesConocidas(['facturas.ver'], ['facturas.gestionar']),
    ).not.toThrow();
  });

  it('un `facturas.gestionar` NUEVO responde 400 (S-D1.4, D1.5)', () => {
    const error = lanzado(() =>
      exigirClavesConocidas(
        ['facturas.gestionar', 'facturas.ver'],
        ['facturas.ver'],
      ),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe(
      'Permisos que no existen: facturas.gestionar',
    );
  });

  it('un `inmuebles.aprobar` NUEVO (gramática válida, no ofrecido) responde 400 (S-D1.4)', () => {
    expect(() => exigirClavesConocidas(['inmuebles.aprobar'], [])).toThrow(
      BadRequestException,
    );
  });

  it('sin `antes` se juzga la lista entera', () => {
    expect(() => exigirClavesConocidas(['inventada.ver'])).toThrow(
      BadRequestException,
    );
  });

  it('el administrador de plataforma también recibe 400: la exención es del tope, no del catálogo (S-D1.3, D1.4)', () => {
    // exigirDelegacion exempts the platform admin, exigirClavesConocidas has
    // no actor at all: both are applied by the services, in that order.
    expect(() =>
      exigirDelegacion(admin, [], ['inmuebles.aprobar']),
    ).not.toThrow();
    expect(() => exigirClavesConocidas(['inmuebles.aprobar'], [])).toThrow(
      BadRequestException,
    );
  });

  it('no nombra dos veces una clave repetida', () => {
    const error = lanzado(() =>
      exigirClavesConocidas(['tareas.volar', 'tareas.volar']),
    );

    expect((error as BadRequestException).message).toBe(
      'Permisos que no existen: tareas.volar',
    );
  });
});

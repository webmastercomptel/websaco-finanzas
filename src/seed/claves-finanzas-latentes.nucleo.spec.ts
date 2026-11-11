import { MODULE_TO_SUBJECT_ADMINISTRACION } from '../modules/casl/permission-map';
import { PERMISOS_FINANZAS } from '../modules/casl/permisos-catalogo';
import {
  clavesAdministracionNoCatalogadas,
  clavesFinancierasPorSegmento,
  clavesRealesDe,
  ejecutar,
  expandirGestionar,
  informe,
  leerModo,
  planificarConversion,
  planificarRetiro,
  quitarAprobarMuerto,
  quitarClavesFinancieras,
  type AlmacenClaves,
  type AsignacionLeida,
  type RolLeido,
} from './claves-finanzas-latentes.nucleo';

let secuencia = 0;

function asignacion(
  permisos: string[],
  extra: Partial<AsignacionLeida> = {},
): AsignacionLeida {
  secuencia += 1;
  return {
    id: `a${secuencia}`,
    email: `persona${secuencia}@x.co`,
    perfil: 'administrativo',
    alcance: 'copropiedad',
    destino: 'COP-001',
    estado: 'active',
    permisos,
    ...extra,
  };
}

function rol(permisos: string[], extra: Partial<RolLeido> = {}): RolLeido {
  secuencia += 1;
  return {
    id: `r${secuencia}`,
    copropiedad: 'COP-001',
    nombre: `Rol ${secuencia}`,
    permisos,
    titularesActivos: 0,
    ...extra,
  };
}

/** In-memory store: the same conditional-write contract as the Mongo one. */
function almacenEnMemoria(inicial: {
  asignaciones: AsignacionLeida[];
  roles: RolLeido[];
}) {
  const asignaciones = inicial.asignaciones.map((a) => ({
    ...a,
    permisos: [...a.permisos],
  }));
  const roles = inicial.roles.map((r) => ({ ...r, permisos: [...r.permisos] }));
  const estado = {
    escrituras: 0,
    antesDeEscribir: undefined as undefined | (() => void),
  };
  const almacen: AlmacenClaves = {
    leerAsignaciones: () =>
      Promise.resolve(
        asignaciones.map((a) => ({ ...a, permisos: [...a.permisos] })),
      ),
    leerRoles: () =>
      Promise.resolve(roles.map((r) => ({ ...r, permisos: [...r.permisos] }))),
    reemplazarPermisos: (tipo, id, esperadas, nuevas) => {
      estado.antesDeEscribir?.();
      const coleccion = tipo === 'rol' ? roles : asignaciones;
      const fila = coleccion.find((f) => f.id === id);
      if (
        !fila ||
        JSON.stringify(fila.permisos) !== JSON.stringify(esperadas)
      ) {
        return Promise.resolve(false);
      }
      fila.permisos = [...nuevas];
      estado.escrituras += 1;
      return Promise.resolve(true);
    },
  };
  return { almacen, asignaciones, roles, estado };
}

const MODO_LISTAR = { aplicar: false, retirarGestionar: false };
const MODO_APLICAR = { aplicar: true, retirarGestionar: false };
const MODO_VISTA_PREVIA = { aplicar: false, retirarGestionar: true };
const MODO_RETIRAR = { aplicar: true, retirarGestionar: true };

describe('clavesFinancierasPorSegmento', () => {
  it('detecta por SEGMENTO, no por moduloDePermiso: facturas.gestionar ya no es una clave conocida y aun así se encuentra', () => {
    expect(
      clavesFinancierasPorSegmento([
        'facturas.gestionar',
        'facturas.ver',
        'pqr.ver',
        'documentos.ver',
        'documentos-administracion.ver',
        'recibos.volar',
        'inventada.ver',
        'facturas',
        'facturas.ver.x',
      ]),
    ).toEqual([
      'facturas.gestionar',
      'facturas.ver',
      'documentos.ver',
      'recibos.volar',
    ]);
  });

  it('quitarClavesFinancieras conserva el resto en su orden y no toca Administración ni desconocidas', () => {
    expect(
      quitarClavesFinancieras([
        'pqr.ver',
        'facturas.gestionar',
        'inventada.ver',
        'recibos.crear',
        'tareas.gestionar',
      ]),
    ).toEqual(['pqr.ver', 'inventada.ver', 'tareas.gestionar']);
  });
});

describe('expandirGestionar', () => {
  it.each([
    [
      'facturas',
      [
        'facturas.ver',
        'facturas.crear',
        'facturas.editar',
        'facturas.anular',
        'facturas.aprobar',
        'facturas.depurar',
      ],
    ],
    [
      'recibos',
      ['recibos.ver', 'recibos.crear', 'recibos.anular', 'recibos.aprobar'],
    ],
    ['consultas', ['consultas.ver']],
    [
      'inmuebles',
      [
        'inmuebles.ver',
        'inmuebles.crear',
        'inmuebles.editar',
        'inmuebles.depurar',
      ],
    ],
    [
      'conceptos',
      [
        'conceptos.ver',
        'conceptos.crear',
        'conceptos.editar',
        'conceptos.depurar',
      ],
    ],
    ['documentos', ['documentos.ver', 'documentos.crear', 'documentos.editar']],
    [
      'interfaz-comptable',
      [
        'interfaz-comptable.ver',
        'interfaz-comptable.crear',
        'interfaz-comptable.anular',
      ],
    ],
  ])(
    '%s.gestionar suma las claves reales de %s según el catálogo nuevo',
    (segmento, reales) => {
      const resultado = expandirGestionar([`${segmento}.gestionar`]);

      expect(resultado[0]).toBe(`${segmento}.gestionar`);
      expect(resultado.slice(1).sort()).toEqual([...reales].sort());
      expect(clavesRealesDe(segmento).sort()).toEqual([...reales].sort());
    },
  );

  it('S-M1.6: anulaciones.gestionar no se expande a nada y no pierde nada', () => {
    expect(clavesRealesDe('anulaciones')).toEqual([]);
    expect(expandirGestionar(['anulaciones.gestionar'])).toEqual([
      'anulaciones.gestionar',
    ]);
  });

  it('es aditiva: conserva x.gestionar y todo lo que ya había, y no duplica', () => {
    const base = ['facturas.gestionar', 'facturas.ver', 'pqr.ver'];

    const una = expandirGestionar(base);

    expect(una.slice(0, 3)).toEqual(base);
    expect(new Set(una).size).toBe(una.length);
    expect(una).toContain('facturas.depurar');
  });

  it('es idempotente', () => {
    const una = expandirGestionar(['recibos.gestionar', 'consultas.gestionar']);

    expect(expandirGestionar(una)).toEqual(una);
  });

  it('no inventa claves para segmentos de Administración: pqr.gestionar queda como está', () => {
    expect(expandirGestionar(['pqr.gestionar', 'tareas.gestionar'])).toEqual([
      'pqr.gestionar',
      'tareas.gestionar',
    ]);
  });

  it('todas las claves que agrega existen en el catálogo ofrecido', () => {
    const todas = expandirGestionar(
      [...new Set(PERMISOS_FINANZAS.map((k) => k.split('.')[0]))].map(
        (s) => `${s}.gestionar`,
      ),
    );

    for (const clave of todas) {
      if (clave.endsWith('.gestionar')) continue;
      expect(PERMISOS_FINANZAS).toContain(clave);
    }
  });
});

describe('quitarAprobarMuerto (B4.7)', () => {
  it('recibos.aprobar sin recibos.gestionar es una clave muerta de antes de B0: se quita', () => {
    expect(quitarAprobarMuerto(['recibos.aprobar'])).toEqual([]);
    expect(
      quitarAprobarMuerto(['recibos.ver', 'recibos.aprobar', 'pqr.ver']),
    ).toEqual(['recibos.ver', 'pqr.ver']);
  });

  it('con recibos.gestionar se queda: es la que se le dará de todos modos', () => {
    expect(
      quitarAprobarMuerto(['recibos.gestionar', 'recibos.aprobar']),
    ).toEqual(['recibos.gestionar', 'recibos.aprobar']);
  });

  it('no toca facturas.aprobar ni otras claves', () => {
    expect(
      quitarAprobarMuerto(['facturas.aprobar', 'reservas.aprobar']),
    ).toEqual(['facturas.aprobar', 'reservas.aprobar']);
  });
});

describe('clavesAdministracionNoCatalogadas (B4.8)', () => {
  it('S-B4.8: cada uno de los 13 segmentos con un verbo gramatical que el catálogo no ofrece se reporta', () => {
    const segmentos = Object.keys(MODULE_TO_SUBJECT_ADMINISTRACION);
    expect(segmentos).toHaveLength(13);

    for (const segmento of segmentos) {
      expect(
        clavesAdministracionNoCatalogadas([`${segmento}.exportar`]),
      ).toEqual([`${segmento}.exportar`]);
    }
  });

  it('reporta usuarios.gestionar y pqr.crear; una clave catalogada es el negativo', () => {
    expect(
      clavesAdministracionNoCatalogadas([
        'usuarios.gestionar',
        'pqr.crear',
        'pqr.ver',
        'roles.gestionar',
        'dashboard.ver',
      ]),
    ).toEqual(['usuarios.gestionar', 'pqr.crear']);
  });

  it('ignora lo que no es de Administración o no es gramatical', () => {
    expect(
      clavesAdministracionNoCatalogadas([
        'facturas.ver',
        'facturas.gestionar',
        'tareas.volar',
        'inventada.ver',
        'pqr',
        'pqr.ver.x',
      ]),
    ).toEqual([]);
  });
});

describe('planificarConversion', () => {
  it('S-M1.3: una fila personal se despoja, nunca se expande (copropiedad y entidad, cualquier estado)', () => {
    const filas = [
      asignacion(['facturas.gestionar', 'pqr.ver'], { perfil: 'personal' }),
      asignacion(['facturas.gestionar'], {
        perfil: 'personal',
        alcance: 'entidad',
        destino: 'ENT-1',
      }),
      asignacion(['facturas.ver', 'recibos.crear'], {
        perfil: 'personal',
        estado: 'inactive',
      }),
    ];

    const plan = planificarConversion(filas, []);

    expect(plan.cambios.map((c) => c.despues)).toEqual([['pqr.ver'], [], []]);
    expect(
      plan.cambios.every((c) => c.motivos.join() === 'quitar-personal'),
    ).toBe(true);
    expect(plan.cambios[0].quitadas).toEqual(['facturas.gestionar']);
  });

  it('una fila de otro perfil, o sin perfil (legado), se expande y conserva x.gestionar', () => {
    const filas = [
      asignacion(['facturas.gestionar'], { perfil: 'administrativo' }),
      asignacion(['inmuebles.gestionar'], { perfil: null }),
      asignacion(['conceptos.gestionar'], {
        perfil: undefined,
        estado: 'inactive',
      }),
    ];

    const plan = planificarConversion(filas, []);

    expect(plan.cambios).toHaveLength(3);
    expect(plan.cambios[0].despues).toEqual([
      'facturas.gestionar',
      ...clavesRealesDe('facturas'),
    ]);
    expect(plan.cambios[0].quitadas).toEqual([]);
    expect(plan.cambios[0].agregadas).toEqual(
      [...clavesRealesDe('facturas')].sort(),
    );
    expect(plan.cambios.every((c) => c.motivos.join() === 'expandir')).toBe(
      true,
    );
  });

  it('Administración, claves desconocidas y el perfil no se tocan: sin Finanzas no hay cambio', () => {
    const plan = planificarConversion(
      [
        asignacion(['pqr.gestionar', 'tareas.ver', 'inventada.ver'], {
          perfil: 'personal',
        }),
        asignacion(['pqr.gestionar', 'usuarios.gestionar']),
      ],
      [rol(['pqr.ver', 'tareas.gestionar'])],
    );

    expect(plan.cambios).toEqual([]);
  });

  it('un rol se despoja de las claves de Finanzas (gestionar incluido); lo demás queda', () => {
    const plan = planificarConversion(
      [],
      [
        rol(['recibos.crear', 'pqr.ver', 'facturas.gestionar'], {
          titularesActivos: 2,
        }),
      ],
    );

    expect(plan.cambios).toHaveLength(1);
    expect(plan.cambios[0]).toMatchObject({
      tipo: 'rol',
      despues: ['pqr.ver'],
      quitadas: ['facturas.gestionar', 'recibos.crear'],
      motivos: ['quitar-rol'],
    });
  });

  it('un rol o una fila que quedan sin claves siguen siendo válidos (lista vacía)', () => {
    const plan = planificarConversion(
      [asignacion(['facturas.ver'], { perfil: 'personal' })],
      [rol(['facturas.ver'])],
    );

    expect(plan.cambios.map((c) => c.despues)).toEqual([[], []]);
  });

  describe('B4.7: recibos.aprobar muerto', () => {
    const aprobarDe = (permisos: string[]) =>
      planificarConversion([asignacion(permisos)], []).cambios[0];

    it("['recibos.aprobar'] solo: se lista y se quita", () => {
      const cambio = aprobarDe(['recibos.aprobar']);

      expect(cambio.despues).toEqual([]);
      expect(cambio.quitadas).toEqual(['recibos.aprobar']);
      expect(cambio.motivos).toEqual(['aprobar-muerta']);
    });

    it("['recibos.gestionar'] termina con recibos.aprobar (la expansión no se deshace)", () => {
      const cambio = aprobarDe(['recibos.gestionar']);

      expect(cambio.despues).toContain('recibos.aprobar');
      expect(cambio.quitadas).toEqual([]);
      expect(cambio.motivos).toEqual(['expandir']);
    });

    it("['recibos.gestionar','recibos.aprobar'] la conserva", () => {
      const cambio = aprobarDe(['recibos.gestionar', 'recibos.aprobar']);

      expect(cambio.despues).toContain('recibos.aprobar');
      expect(cambio.quitadas).toEqual([]);
    });

    it('la decisión se toma sobre el arreglo LEÍDO: facturas.gestionar no salva a un recibos.aprobar suelto, y puede haber los dos motivos', () => {
      const cambio = aprobarDe(['recibos.aprobar', 'facturas.gestionar']);

      expect(cambio.motivos).toEqual(['aprobar-muerta', 'expandir']);
      expect(cambio.despues).not.toContain('recibos.aprobar');
      expect(cambio.despues).toContain('facturas.aprobar');
    });

    it('una fila personal se despoja entera de todos modos (un solo motivo)', () => {
      const cambio = planificarConversion(
        [asignacion(['recibos.aprobar'], { perfil: 'personal' })],
        [],
      ).cambios[0];

      expect(cambio.despues).toEqual([]);
      expect(cambio.motivos).toEqual(['quitar-personal']);
    });

    it('una segunda pasada ya no lista nada', async () => {
      const { almacen } = almacenEnMemoria({
        asignaciones: [
          asignacion(['recibos.aprobar']),
          asignacion(['recibos.gestionar']),
        ],
        roles: [],
      });

      await ejecutar(MODO_APLICAR, almacen);
      const segunda = await ejecutar(MODO_LISTAR, almacen);

      expect(segunda.codigoSalida).toBe(0);
      expect(segunda.conversion?.cambios).toEqual([]);
    });
  });

  it('B4.8: informa las claves de Administración no catalogadas por fila, sin proponer cambio ni afectar a los pendientes', () => {
    const conRaras = asignacion(['usuarios.gestionar', 'pqr.crear', 'pqr.ver']);
    const limpia = asignacion(['pqr.ver']);

    const plan = planificarConversion([conRaras, limpia], []);

    expect(plan.cambios).toEqual([]);
    expect(plan.sinCatalogar).toEqual([
      { fila: conRaras, claves: ['usuarios.gestionar', 'pqr.crear'] },
    ]);
  });
});

describe('ejecutar: modo por defecto y --aplicar (S-M1.1, S-M1.2)', () => {
  const escenario = () =>
    almacenEnMemoria({
      asignaciones: [
        asignacion(['facturas.ver', 'pqr.ver'], { perfil: 'personal' }),
        asignacion(['facturas.gestionar']),
      ],
      roles: [rol(['recibos.crear'])],
    });

  it('S-M1.1: por defecto lista las tres operaciones, escribe 0 y sale con código 1', async () => {
    const { almacen, estado } = escenario();

    const resultado = await ejecutar(MODO_LISTAR, almacen);

    expect(resultado.conversion?.cambios).toHaveLength(3);
    expect(resultado.aplicados).toEqual([]);
    expect(estado.escrituras).toBe(0);
    expect(resultado.codigoSalida).toBe(1);
  });

  it('S-M1.2: --aplicar deja la fila personal con pqr.ver, el rol vacío y la otra fila con las claves reales y gestionar; luego la lista por defecto no encuentra nada y sale 0', async () => {
    const { almacen, asignaciones, roles } = escenario();

    const aplicado = await ejecutar(MODO_APLICAR, almacen);

    expect(aplicado.aplicados).toHaveLength(3);
    expect(aplicado.conflictos).toEqual([]);
    expect(aplicado.codigoSalida).toBe(0);
    expect(asignaciones[0].permisos).toEqual(['pqr.ver']);
    expect(roles[0].permisos).toEqual([]);
    expect(asignaciones[1].permisos).toEqual([
      'facturas.gestionar',
      'facturas.ver',
      'facturas.crear',
      'facturas.editar',
      'facturas.anular',
      'facturas.aprobar',
      'facturas.depurar',
    ]);

    const segunda = await ejecutar(MODO_LISTAR, almacen);
    expect(segunda.conversion?.cambios).toEqual([]);
    expect(segunda.codigoSalida).toBe(0);
  });

  it('sin nada pendiente sale 0 desde el principio', async () => {
    const { almacen } = almacenEnMemoria({
      asignaciones: [asignacion(['pqr.ver'])],
      roles: [],
    });

    expect((await ejecutar(MODO_LISTAR, almacen)).codigoSalida).toBe(0);
  });

  it('S-M1.5: una fila que cambió entre la lectura y la escritura se informa como conflicto y no se pisa', async () => {
    const { almacen, asignaciones, estado } = almacenEnMemoria({
      asignaciones: [
        asignacion(['facturas.gestionar']),
        asignacion(['recibos.gestionar']),
      ],
      roles: [],
    });
    let primera = true;
    estado.antesDeEscribir = () => {
      if (!primera) return;
      primera = false;
      // Someone adds a key to the first row after the script read it.
      asignaciones[0].permisos.push('pqr.ver');
    };

    const resultado = await ejecutar(MODO_APLICAR, almacen);

    expect(resultado.conflictos).toHaveLength(1);
    expect(resultado.conflictos[0].fila.id).toBe(asignaciones[0].id);
    expect(resultado.aplicados).toHaveLength(1);
    expect(asignaciones[0].permisos).toEqual(['facturas.gestionar', 'pqr.ver']);
    expect(resultado.codigoSalida).toBe(1);
  });

  it('es idempotente: aplicar dos veces escribe lo mismo que una', async () => {
    const { almacen, estado } = escenario();

    await ejecutar(MODO_APLICAR, almacen);
    const escrituras = estado.escrituras;
    await ejecutar(MODO_APLICAR, almacen);

    expect(estado.escrituras).toBe(escrituras);
  });

  it('el informe nombra id, correo, alcance, destino, estado y claves de cada fila y avisa que es previo al despliegue', async () => {
    const { almacen, asignaciones } = escenario();

    const texto = informe(await ejecutar(MODO_LISTAR, almacen)).join('\n');

    expect(texto).toContain(asignaciones[0].id);
    expect(texto).toContain(asignaciones[0].email);
    expect(texto).toContain('copropiedad');
    expect(texto).toContain('COP-001');
    expect(texto).toContain('facturas.ver');
    expect(texto).toMatch(/ANTES del despliegue/);
  });
});

describe('vista previa y --retirar-gestionar (B4.3, S-M1.4)', () => {
  const convertida = () => {
    // A row as the pre-deploy `--aplicar` leaves it.
    const filaLista = asignacion(
      expandirGestionar(['facturas.gestionar', 'pqr.ver']),
    );
    const sinConvertir = asignacion(['recibos.gestionar', 'recibos.ver']);
    const sinGestionar = asignacion(['pqr.ver']);
    const personal = asignacion(['facturas.ver'], { perfil: 'personal' });
    return { filaLista, sinConvertir, sinGestionar, personal };
  };

  it('la vista previa es de solo lectura: lista lo que quitaría, escribe 0 y sale 1', async () => {
    const f = convertida();
    const { almacen, estado } = almacenEnMemoria({
      asignaciones: [f.filaLista, f.sinGestionar, f.personal],
      roles: [],
    });

    const resultado = await ejecutar(MODO_VISTA_PREVIA, almacen);

    expect(resultado.retiro?.cambios).toHaveLength(1);
    expect(resultado.retiro?.cambios[0].quitadas).toEqual([
      'facturas.gestionar',
    ]);
    expect(resultado.retiro?.cambios[0].fila.id).toBe(f.filaLista.id);
    expect(estado.escrituras).toBe(0);
    expect(resultado.codigoSalida).toBe(1);
    const texto = informe(resultado).join('\n');
    expect(texto).toContain(f.filaLista.email);
    expect(texto).toContain('facturas.gestionar');
  });

  it('avisa de la fila a la que le falta alguna clave real (perdería acceso al volver atrás) y no la propone', async () => {
    const f = convertida();
    const { almacen } = almacenEnMemoria({
      asignaciones: [f.sinConvertir],
      roles: [],
    });

    const resultado = await ejecutar(MODO_VISTA_PREVIA, almacen);

    expect(resultado.retiro?.cambios).toEqual([]);
    expect(resultado.retiro?.omitidas).toHaveLength(1);
    expect(resultado.retiro?.omitidas[0].faltantes).toEqual([
      {
        gestionar: 'recibos.gestionar',
        faltan: ['recibos.crear', 'recibos.anular', 'recibos.aprobar'],
      },
    ]);
    // Nothing would be removed, so the preview does not fail a gate on its own.
    expect(resultado.codigoSalida).toBe(0);
    expect(informe(resultado).join('\n')).toMatch(/perdería acceso/);
  });

  it('S-M1.4: --aplicar --retirar-gestionar quita solo x.gestionar de las filas no personal y deja las claves reales', async () => {
    const f = convertida();
    const { almacen, asignaciones } = almacenEnMemoria({
      asignaciones: [f.filaLista, f.sinConvertir, f.sinGestionar, f.personal],
      roles: [],
    });

    const resultado = await ejecutar(MODO_RETIRAR, almacen);

    expect(resultado.aplicados).toHaveLength(1);
    expect(asignaciones[0].permisos).toEqual([
      'pqr.ver',
      'facturas.ver',
      'facturas.crear',
      'facturas.editar',
      'facturas.anular',
      'facturas.aprobar',
      'facturas.depurar',
    ]);
    // The flagged row is skipped (reported), never half-edited.
    expect(asignaciones[1].permisos).toEqual([
      'recibos.gestionar',
      'recibos.ver',
    ]);
    expect(asignaciones[2].permisos).toEqual(['pqr.ver']);
    // A `personal` row is not this mode's business: its Finanzas keys are legitimate now.
    expect(asignaciones[3].permisos).toEqual(['facturas.ver']);
    expect(resultado.retiro?.omitidas).toHaveLength(1);
    expect(resultado.codigoSalida).toBe(0);
  });

  it('no pide retroactivamente la quita de recibos.aprobar: tras retirar recibos.gestionar la clave real se queda', async () => {
    const fila = asignacion(expandirGestionar(['recibos.gestionar']));
    const { almacen, asignaciones } = almacenEnMemoria({
      asignaciones: [fila],
      roles: [],
    });

    const plan = planificarRetiro(await almacen.leerAsignaciones());
    await ejecutar(MODO_RETIRAR, almacen);

    expect(plan.cambios[0].motivos).toEqual(['retirar-gestionar']);
    expect(asignaciones[0].permisos).toContain('recibos.aprobar');
    expect(asignaciones[0].permisos).not.toContain('recibos.gestionar');
  });

  it('anulaciones.gestionar no exige nada: se puede retirar sin aviso', () => {
    const plan = planificarRetiro([asignacion(['anulaciones.gestionar'])]);

    expect(plan.omitidas).toEqual([]);
    expect(plan.cambios[0].despues).toEqual([]);
  });

  it('no toca los roles ni las claves gestionar de Administración', async () => {
    const { almacen, asignaciones, roles, estado } = almacenEnMemoria({
      asignaciones: [asignacion(['pqr.gestionar', 'tareas.gestionar'])],
      roles: [rol(['facturas.ver'])],
    });

    await ejecutar(MODO_RETIRAR, almacen);

    expect(asignaciones[0].permisos).toEqual([
      'pqr.gestionar',
      'tareas.gestionar',
    ]);
    expect(roles[0].permisos).toEqual(['facturas.ver']);
    expect(estado.escrituras).toBe(0);
  });

  it('la escritura también es condicional: una fila que cambió es conflicto', async () => {
    const f = convertida();
    const { almacen, asignaciones, estado } = almacenEnMemoria({
      asignaciones: [f.filaLista],
      roles: [],
    });
    estado.antesDeEscribir = () => asignaciones[0].permisos.push('pqr.crear');

    const resultado = await ejecutar(MODO_RETIRAR, almacen);

    expect(resultado.conflictos).toHaveLength(1);
    expect(asignaciones[0].permisos).toContain('facturas.gestionar');
    expect(resultado.codigoSalida).toBe(1);
  });
});

describe('leerModo', () => {
  it('sin banderas es solo lectura', () => {
    expect(leerModo(['--env=local'])).toEqual(MODO_LISTAR);
  });

  it.each([
    [['--env=local', '--aplicar'], MODO_APLICAR],
    [['--env=local', '--retirar-gestionar'], MODO_VISTA_PREVIA],
    [['--env=local', '--aplicar', '--retirar-gestionar'], MODO_RETIRAR],
    [['--retirar-gestionar', '--aplicar', '--env=dev'], MODO_RETIRAR],
  ])('%j', (argv, esperado) => {
    expect(leerModo(argv)).toEqual(esperado);
  });

  it('una bandera desconocida (una errata) detiene el script antes de tocar nada', () => {
    expect(() => leerModo(['--env=local', '--aplicr'])).toThrow(/--aplicr/);
    expect(() => leerModo(['--env=local', '--db=otra'])).toThrow(/--db=otra/);
  });
});

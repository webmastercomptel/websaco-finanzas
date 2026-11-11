import { createAppAbility, ACTIONS } from './casl-ability.constants';
import { PERMISOS_ADMINISTRACION } from './permisos-catalogo';
import {
  MODULE_TO_SUBJECT,
  MODULE_TO_SUBJECT_ADMINISTRACION,
  VERB_TO_ACTION,
  VERB_TO_ACTION_ADMINISTRACION,
  rulesFromPermissionKeys,
} from './permission-map';

const abilityFor = (keys: string[], platformAdmin = false) =>
  createAppAbility(rulesFromPermissionKeys(keys, { platformAdmin }));

describe('rulesFromPermissionKeys', () => {
  it('traduce una clave modulo.accion a su regla CASL', () => {
    const ability = abilityFor(['facturas.crear']);

    expect(ability.can('create', 'Factura')).toBe(true);
  });

  it('no concede nada más que lo pedido', () => {
    const ability = abilityFor(['facturas.ver']);

    expect(ability.can('read', 'Factura')).toBe(true);
    expect(ability.can('create', 'Factura')).toBe(false);
    expect(ability.can('annul', 'Factura')).toBe(false);
    expect(ability.can('read', 'Recibo')).toBe(false);
  });

  it('da acceso total al administrador de plataforma e ignora sus claves', () => {
    const ability = abilityFor([], true);

    expect(ability.can('annul', 'Factura')).toBe(true);
    expect(ability.can('manage', 'all')).toBe(true);
  });

  it('descarta claves desconocidas o mal formadas sin romperse', () => {
    const ability = abilityFor([
      'inventado.crear',
      'facturas.inventado',
      'basura',
      '',
      'facturas.ver',
    ]);

    // Descartar significa DENEGAR: la clave válida sobrevive, el resto no
    // concede nada.
    expect(ability.can('read', 'Factura')).toBe(true);
    expect(ability.can('create', 'Factura')).toBe(false);
  });

  it.each([
    'constructor.ver',
    '__proto__.ver',
    'toString.ver',
    'facturas.constructor',
    'facturas.__proto__',
    'pqr.constructor',
    'pqr.__proto__',
  ])(
    '%s (nombre heredado de Object.prototype) no concede nada: es desconocida y desconocida es DENEGAR',
    (clave) => {
      expect(rulesFromPermissionKeys([clave])).toEqual([]);
      expect(abilityFor([clave, 'facturas.ver']).can('create', 'Factura')).toBe(
        false,
      );
    },
  );

  it('sin claves no concede ningún permiso', () => {
    const ability = abilityFor([]);

    for (const subject of ['Factura', 'Recibo', 'NotaCredito'] as const) {
      expect(ability.can('read', subject)).toBe(false);
    }
  });

  it('anular es un permiso separado de editar', () => {
    // Anular es el acto más consecuente del dominio: tener permiso de edición
    // NO puede alcanzar para anular un documento.
    const ability = abilityFor(['facturas.editar']);

    expect(ability.can('update', 'Factura')).toBe(true);
    expect(ability.can('annul', 'Factura')).toBe(false);
  });

  it('en Finanzas `gestionar` ya no es una clave: no concede nada', () => {
    // Amendment G: unknown key = deny, for every financial segment.
    for (const modulo of Object.keys(MODULE_TO_SUBJECT)) {
      expect(abilityFor([`${modulo}.gestionar`]).rules).toHaveLength(0);
    }
    const ability = abilityFor(['recibos.gestionar']);

    expect(ability.can('annul', 'Recibo')).toBe(false);
    expect(ability.can('create', 'Recibo')).toBe(false);
    expect(ability.can('read', 'Recibo')).toBe(false);
    expect(ability.can('manage', 'Recibo')).toBe(false);
  });

  it('`depurar` concede `purge` sobre su materia y nada más', () => {
    const ability = abilityFor(['facturas.depurar']);

    expect(ability.can('purge', 'Factura')).toBe(true);
    expect(ability.can('read', 'Factura')).toBe(false);
    expect(ability.can('annul', 'Factura')).toBe(false);
    expect(ability.can('purge', 'Recibo')).toBe(false);
  });

  it('`depurar` NUNCA concede `remove`: nada financiero se borra como documento', () => {
    for (const clave of [
      'facturas.depurar',
      'inmuebles.depurar',
      'conceptos.depurar',
    ]) {
      const ability = abilityFor([clave]);
      for (const sujeto of Object.values(MODULE_TO_SUBJECT)) {
        expect(ability.can('remove', sujeto)).toBe(false);
      }
    }
  });

  it('recibos.aprobar concede `approve` sobre Recibo y nada más', () => {
    const ability = abilityFor(['recibos.aprobar']);

    expect(ability.can('approve', 'Recibo')).toBe(true);
    expect(ability.can('create', 'Recibo')).toBe(false);
    expect(ability.can('approve', 'Factura')).toBe(false);
  });
});

describe('vocabulario de autorización', () => {
  it('no existe la acción "eliminar" en el mapa de verbos', () => {
    // Ningún documento financiero se borra: si este test falla, alguien
    // reintrodujo el borrado físico por la puerta de atrás.
    expect(Object.keys(VERB_TO_ACTION)).not.toContain('eliminar');
  });

  it('el mapa financiero no tiene `gestionar` y sí `depurar` -> purge', () => {
    expect(Object.keys(VERB_TO_ACTION)).not.toContain('gestionar');
    expect(VERB_TO_ACTION.depurar).toBe('purge');
    // `gestionar` lives only on the Administración side.
    expect(VERB_TO_ACTION_ADMINISTRACION.gestionar).toBe('manage');
  });

  it('`purge` es una acción propia, distinta de `remove`', () => {
    expect(ACTIONS as readonly string[]).toContain('purge');
    expect(VERB_TO_ACTION.depurar).not.toBe('remove');
  });

  it('no existe la acción "delete" en el vocabulario CASL', () => {
    expect(ACTIONS as readonly string[]).not.toContain('delete');
  });

  it('todo verbo del mapa apunta a una acción del vocabulario', () => {
    for (const action of Object.values(VERB_TO_ACTION)) {
      expect(ACTIONS as readonly string[]).toContain(action);
    }
  });

  it('cubre los siete módulos financieros del backlog', () => {
    for (const modulo of [
      'facturas',
      'recibos',
      'notas-credito',
      'notas-contables',
      'otras-notas',
      'anulaciones',
      'consultas',
    ]) {
      expect(Object.keys(MODULE_TO_SUBJECT)).toContain(modulo);
    }
  });

  it('el catálogo tiene permisos propios, separados de las consultas', () => {
    // Quien lee el reporte de cartera no queda por eso habilitado a reescribir
    // quién es dueño de un inmueble. Otorgar las dos cosas con una sola llave
    // es exactamente cómo eso pasa sin que nadie lo decida.
    for (const modulo of ['inmuebles', 'terceros', 'conceptos']) {
      expect(Object.keys(MODULE_TO_SUBJECT)).toContain(modulo);
    }

    expect(MODULE_TO_SUBJECT.inmuebles).not.toBe(MODULE_TO_SUBJECT.consultas);
  });
});

describe('permisos de OtraNota (Notas Débito)', () => {
  it('otras-notas.ver concede lectura sobre OtraNota', () => {
    const ability = abilityFor(['otras-notas.ver']);

    expect(ability.can('read', 'OtraNota')).toBe(true);
    expect(ability.can('create', 'OtraNota')).toBe(false);
    expect(ability.can('annul', 'OtraNota')).toBe(false);
  });

  it('otras-notas.crear concede creación sobre OtraNota', () => {
    const ability = abilityFor(['otras-notas.crear']);

    expect(ability.can('create', 'OtraNota')).toBe(true);
    expect(ability.can('read', 'OtraNota')).toBe(false);
    expect(ability.can('annul', 'OtraNota')).toBe(false);
  });

  it('otras-notas.anular concede anulación sobre OtraNota', () => {
    const ability = abilityFor(['otras-notas.anular']);

    expect(ability.can('annul', 'OtraNota')).toBe(true);
    expect(ability.can('create', 'OtraNota')).toBe(false);
    expect(ability.can('read', 'OtraNota')).toBe(false);
  });

  it('permisos de OtraNota no cruzan con otros documentos financieros', () => {
    const ability = abilityFor([
      'otras-notas.ver',
      'otras-notas.crear',
      'otras-notas.anular',
    ]);

    expect(ability.can('read', 'OtraNota')).toBe(true);
    expect(ability.can('read', 'Factura')).toBe(false);
    expect(ability.can('read', 'Recibo')).toBe(false);
    expect(ability.can('read', 'NotaCredito')).toBe(false);
  });

  it('permisos de otros documentos no conceden acceso a OtraNota', () => {
    const ability = abilityFor([
      'facturas.ver',
      'facturas.crear',
      'recibos.ver',
      'recibos.crear',
      'notas-credito.ver',
      'notas-credito.crear',
    ]);

    expect(ability.can('read', 'OtraNota')).toBe(false);
    expect(ability.can('create', 'OtraNota')).toBe(false);
    expect(ability.can('annul', 'OtraNota')).toBe(false);
  });
});

describe('permisos de NotaContable', () => {
  it('notas-contables.ver concede lectura sobre NotaContable', () => {
    const ability = abilityFor(['notas-contables.ver']);

    expect(ability.can('read', 'NotaContable')).toBe(true);
    expect(ability.can('create', 'NotaContable')).toBe(false);
    expect(ability.can('annul', 'NotaContable')).toBe(false);
  });

  it('notas-contables.crear concede creación sobre NotaContable', () => {
    const ability = abilityFor(['notas-contables.crear']);

    expect(ability.can('create', 'NotaContable')).toBe(true);
    expect(ability.can('read', 'NotaContable')).toBe(false);
    expect(ability.can('annul', 'NotaContable')).toBe(false);
  });

  it('notas-contables.anular concede anulación sobre NotaContable', () => {
    const ability = abilityFor(['notas-contables.anular']);

    expect(ability.can('annul', 'NotaContable')).toBe(true);
    expect(ability.can('create', 'NotaContable')).toBe(false);
    expect(ability.can('read', 'NotaContable')).toBe(false);
  });

  it('permisos de NotaContable no cruzan con otros documentos financieros', () => {
    const ability = abilityFor([
      'notas-contables.ver',
      'notas-contables.crear',
      'notas-contables.anular',
    ]);

    expect(ability.can('read', 'NotaContable')).toBe(true);
    expect(ability.can('read', 'Factura')).toBe(false);
    expect(ability.can('read', 'Recibo')).toBe(false);
    expect(ability.can('read', 'NotaCredito')).toBe(false);
    expect(ability.can('read', 'OtraNota')).toBe(false);
  });

  it('permisos de otros documentos no conceden acceso a NotaContable', () => {
    const ability = abilityFor([
      'facturas.ver',
      'facturas.crear',
      'recibos.ver',
      'recibos.crear',
      'notas-credito.ver',
      'notas-credito.crear',
      'otras-notas.ver',
      'otras-notas.crear',
    ]);

    expect(ability.can('read', 'NotaContable')).toBe(false);
    expect(ability.can('create', 'NotaContable')).toBe(false);
    expect(ability.can('annul', 'NotaContable')).toBe(false);
  });
});

describe('permisos de Configuracion (Maestro de Cuentas, Parámetros, Documentos)', () => {
  it('las tres claves de módulo nuevas resuelven al mismo subject Configuracion', () => {
    expect(MODULE_TO_SUBJECT['cuentas-contables']).toBe('Configuracion');
    expect(MODULE_TO_SUBJECT['parametros-facturacion']).toBe('Configuracion');
    expect(MODULE_TO_SUBJECT.documentos).toBe('Configuracion');
  });

  it('cuentas-contables.ver concede solo lectura sobre Configuracion', () => {
    const ability = abilityFor(['cuentas-contables.ver']);

    expect(ability.can('read', 'Configuracion')).toBe(true);
    expect(ability.can('create', 'Configuracion')).toBe(false);
    expect(ability.can('update', 'Configuracion')).toBe(false);
  });

  it('documentos.editar concede actualización sobre Configuracion', () => {
    const ability = abilityFor(['documentos.editar']);

    expect(ability.can('update', 'Configuracion')).toBe(true);
    expect(ability.can('read', 'Configuracion')).toBe(false);
  });

  it('un permiso de Configuracion no concede acceso a otros subjects', () => {
    const ability = abilityFor(['parametros-facturacion.editar']);

    expect(ability.can('read', 'Factura')).toBe(false);
    expect(ability.can('read', 'ConceptoCobro')).toBe(false);
  });

  it('permisos de otros módulos no conceden acceso a Configuracion', () => {
    const ability = abilityFor(['facturas.ver', 'conceptos.editar']);

    expect(ability.can('read', 'Configuracion')).toBe(false);
  });
});

describe('reinicio del ciclo de facturación', () => {
  it('ya no existe como permiso CASL: la llave heredada se ignora y no concede nada', () => {
    // Quedó detrás de PlatformAdminGuard. Un rol que aún guarde la clave
    // vieja `ciclo-facturacion-prueba.*` no gana poder alguno por ella.
    const ability = abilityFor([
      'ciclo-facturacion-prueba.reiniciar',
      'ciclo-facturacion-prueba.gestionar',
    ]);

    expect(ability.rules).toHaveLength(0);
  });
});

describe('permisos de SaldoInicial (saldos iniciales de cartera)', () => {
  it('saldos-iniciales.crear concede importar (create) sobre SaldoInicial', () => {
    const ability = abilityFor(['saldos-iniciales.crear']);

    expect(ability.can('create', 'SaldoInicial')).toBe(true);
    expect(ability.can('annul', 'SaldoInicial')).toBe(false);
    expect(ability.can('read', 'SaldoInicial')).toBe(false);
  });

  it('saldos-iniciales.anular concede anulación sobre SaldoInicial', () => {
    const ability = abilityFor(['saldos-iniciales.anular']);

    expect(ability.can('annul', 'SaldoInicial')).toBe(true);
    expect(ability.can('create', 'SaldoInicial')).toBe(false);
  });

  it('permisos de SaldoInicial no cruzan con Factura ni Recibo', () => {
    const ability = abilityFor([
      'saldos-iniciales.ver',
      'saldos-iniciales.crear',
      'saldos-iniciales.anular',
    ]);

    expect(ability.can('read', 'SaldoInicial')).toBe(true);
    expect(ability.can('read', 'Factura')).toBe(false);
    expect(ability.can('read', 'Recibo')).toBe(false);
  });

  it('permisos de otros documentos no conceden acceso a SaldoInicial', () => {
    const ability = abilityFor([
      'facturas.ver',
      'facturas.crear',
      'facturas.depurar',
    ]);

    expect(ability.can('read', 'SaldoInicial')).toBe(false);
    expect(ability.can('create', 'SaldoInicial')).toBe(false);
  });
});

describe('permisos de SaldoInicialAnticipo (saldos iniciales de anticipo)', () => {
  it('saldos-iniciales-anticipo.crear concede importar (create) sobre SaldoInicialAnticipo', () => {
    const ability = abilityFor(['saldos-iniciales-anticipo.crear']);

    expect(ability.can('create', 'SaldoInicialAnticipo')).toBe(true);
    expect(ability.can('annul', 'SaldoInicialAnticipo')).toBe(false);
    expect(ability.can('read', 'SaldoInicialAnticipo')).toBe(false);
  });

  it('saldos-iniciales-anticipo.anular concede anulación sobre SaldoInicialAnticipo', () => {
    const ability = abilityFor(['saldos-iniciales-anticipo.anular']);

    expect(ability.can('annul', 'SaldoInicialAnticipo')).toBe(true);
    expect(ability.can('create', 'SaldoInicialAnticipo')).toBe(false);
  });

  it('permisos de SaldoInicialAnticipo no cruzan con SaldoInicial, Factura ni NotaAnticipo', () => {
    const ability = abilityFor([
      'saldos-iniciales-anticipo.ver',
      'saldos-iniciales-anticipo.crear',
      'saldos-iniciales-anticipo.anular',
    ]);

    expect(ability.can('read', 'SaldoInicialAnticipo')).toBe(true);
    expect(ability.can('read', 'SaldoInicial')).toBe(false);
    expect(ability.can('read', 'Factura')).toBe(false);
    expect(ability.can('read', 'NotaAnticipo')).toBe(false);
  });

  it('permisos de otros documentos no conceden acceso a SaldoInicialAnticipo', () => {
    const ability = abilityFor([
      'notas-anticipo.ver',
      'notas-anticipo.crear',
      'facturas.depurar',
    ]);

    expect(ability.can('read', 'SaldoInicialAnticipo')).toBe(false);
    expect(ability.can('create', 'SaldoInicialAnticipo')).toBe(false);
  });
});

describe('saldos-iniciales y saldos-iniciales-anticipo son permisos independientes', () => {
  it('saldos-iniciales.* no concede nada sobre SaldoInicialAnticipo', () => {
    const ability = abilityFor([
      'saldos-iniciales.ver',
      'saldos-iniciales.crear',
      'saldos-iniciales.anular',
    ]);

    expect(ability.can('read', 'SaldoInicial')).toBe(true);
    expect(ability.can('create', 'SaldoInicial')).toBe(true);
    expect(ability.can('annul', 'SaldoInicial')).toBe(true);
    expect(ability.can('read', 'SaldoInicialAnticipo')).toBe(false);
    expect(ability.can('create', 'SaldoInicialAnticipo')).toBe(false);
    expect(ability.can('annul', 'SaldoInicialAnticipo')).toBe(false);
  });

  it('saldos-iniciales-anticipo.* concede solo SaldoInicialAnticipo', () => {
    const ability = abilityFor([
      'saldos-iniciales-anticipo.ver',
      'saldos-iniciales-anticipo.crear',
      'saldos-iniciales-anticipo.anular',
    ]);

    expect(ability.can('read', 'SaldoInicialAnticipo')).toBe(true);
    expect(ability.can('create', 'SaldoInicialAnticipo')).toBe(true);
    expect(ability.can('annul', 'SaldoInicialAnticipo')).toBe(true);
    expect(ability.can('read', 'SaldoInicial')).toBe(false);
    expect(ability.can('create', 'SaldoInicial')).toBe(false);
    expect(ability.can('annul', 'SaldoInicial')).toBe(false);
  });

  it('el permiso no se extiende a otros subjects', () => {
    const ability = abilityFor([
      'saldos-iniciales.ver',
      'saldos-iniciales-anticipo.ver',
    ]);

    expect(ability.can('read', 'NotaAnticipo')).toBe(false);
    expect(ability.can('read', 'Factura')).toBe(false);
  });
});

describe('permisos de Interfaz a Comptable', () => {
  it('el módulo interfaz-comptable resuelve a su propio subject', () => {
    expect(MODULE_TO_SUBJECT['interfaz-comptable']).toBe('InterfazComptable');
  });

  it('ver, crear y anular conceden leer, enviar y retirar por separado', () => {
    const ver = abilityFor(['interfaz-comptable.ver']);
    expect(ver.can('read', 'InterfazComptable')).toBe(true);
    expect(ver.can('create', 'InterfazComptable')).toBe(false);
    expect(ver.can('annul', 'InterfazComptable')).toBe(false);

    const crear = abilityFor(['interfaz-comptable.crear']);
    expect(crear.can('create', 'InterfazComptable')).toBe(true);
    expect(crear.can('annul', 'InterfazComptable')).toBe(false);

    const anular = abilityFor(['interfaz-comptable.anular']);
    expect(anular.can('annul', 'InterfazComptable')).toBe(true);
    expect(anular.can('create', 'InterfazComptable')).toBe(false);
  });

  it('adicion-contabilidad no concede nada sobre Interfaz a Comptable', () => {
    const ability = abilityFor([
      'adicion-contabilidad.ver',
      'adicion-contabilidad.crear',
      'adicion-contabilidad.anular',
      'adicion-contabilidad.editar',
    ]);

    expect(ability.can('read', 'InterfazComptable')).toBe(false);
    expect(ability.can('create', 'InterfazComptable')).toBe(false);
    expect(ability.can('annul', 'InterfazComptable')).toBe(false);
  });

  it('interfaz-comptable no concede nada sobre Adición a Contabilidad (Configuracion)', () => {
    const ability = abilityFor([
      'interfaz-comptable.ver',
      'interfaz-comptable.crear',
      'interfaz-comptable.anular',
      'interfaz-comptable.editar',
    ]);

    expect(ability.can('read', 'Configuracion')).toBe(false);
    expect(ability.can('create', 'Configuracion')).toBe(false);
  });
});

describe('permisos de Administración', () => {
  it('traduce una clave de Administración a su regla CASL', () => {
    const ability = abilityFor(['anuncios.crear', 'tareas.actualizar']);

    expect(ability.can('create', 'Anuncio')).toBe(true);
    expect(ability.can('update', 'Tarea')).toBe(true);
    expect(ability.can('read', 'Anuncio')).toBe(false);
  });

  it('"eliminar" existe solo en Administración y se traduce a la acción "remove"', () => {
    const ability = abilityFor(['anuncios.eliminar']);

    expect(ability.can('remove', 'Anuncio')).toBe(true);
    expect(ability.can('manage', 'Anuncio')).toBe(false);
  });

  it('"eliminar" sobre un módulo financiero se ignora: nada financiero se borra', () => {
    const ability = abilityFor(['facturas.eliminar', 'recibos.eliminar']);

    expect(ability.can('remove', 'Factura')).toBe(false);
    expect(ability.can('remove', 'Recibo')).toBe(false);
    expect(ability.can('read', 'Factura')).toBe(false);
  });

  it('"remove" no puede aplicarse a ninguna materia financiera ni siquiera con depurar', () => {
    const ability = abilityFor(['facturas.depurar', 'documentos.depurar']);

    expect(ability.can('purge', 'Factura')).toBe(true);
    expect(ability.can('remove', 'Factura')).toBe(false);
    expect(ability.can('remove', 'Configuracion')).toBe(false);
  });

  it('"remove" sigue vetado en toda materia financiera para el administrador de plataforma', () => {
    const ability = abilityFor([], true);

    for (const sujeto of Object.values(MODULE_TO_SUBJECT)) {
      expect(ability.can('remove', sujeto)).toBe(false);
      // The platform admin still reaches the guarded hard deletes.
      expect(ability.can('purge', sujeto)).toBe(true);
    }
    expect(ability.can('remove', 'Anuncio')).toBe(true);
  });

  it('"documentos" sigue siendo de Finanzas y el de Administración tiene su propio segmento', () => {
    expect(abilityFor(['documentos.ver']).can('read', 'Configuracion')).toBe(
      true,
    );
    expect(abilityFor(['documentos.ver']).can('read', 'Documento')).toBe(false);
    expect(
      abilityFor(['documentos-administracion.ver']).can('read', 'Documento'),
    ).toBe(true);
  });

  it('"gestionar" en Administración concede todo sobre su materia, incluido remove', () => {
    const ability = abilityFor(['pqr.gestionar']);

    expect(ability.can('manage', 'Pqr')).toBe(true);
    expect(ability.can('remove', 'Pqr')).toBe(true);
    expect(ability.can('read', 'Anuncio')).toBe(false);
  });

  it('"gestionar" de Administración sigue siendo `manage` en cada materia que lo ofrece', () => {
    expect(abilityFor(['roles.gestionar']).can('manage', 'Rol')).toBe(true);
    expect(abilityFor(['tareas.gestionar']).can('manage', 'Tarea')).toBe(true);
  });

  it('un `gestionar` de Administración no abre ninguna materia financiera', () => {
    const ability = abilityFor(['pqr.gestionar', 'roles.gestionar']);

    for (const sujeto of Object.values(MODULE_TO_SUBJECT)) {
      expect(ability.can('read', sujeto)).toBe(false);
    }
  });
});

describe('verbos de Administración: no heredan los verbos solo de Finanzas', () => {
  // The vocabulary every catalogued Administración key uses today. Pinned
  // literally so a refactor of the tables cannot move any of them.
  const ACCION_POR_VERBO_ADMINISTRACION = {
    ver: 'read',
    crear: 'create',
    editar: 'update',
    aprobar: 'approve',
    gestionar: 'manage',
    subir: 'create',
    actualizar: 'update',
    eliminar: 'remove',
  } as const;

  it('cada clave catalogada de Administración se traduce como siempre', () => {
    expect(PERMISOS_ADMINISTRACION.length).toBeGreaterThan(0);
    for (const { id } of PERMISOS_ADMINISTRACION) {
      const [segmento, verbo] = id.split('.');
      const accion =
        ACCION_POR_VERBO_ADMINISTRACION[
          verbo as keyof typeof ACCION_POR_VERBO_ADMINISTRACION
        ];
      const sujeto =
        MODULE_TO_SUBJECT_ADMINISTRACION[
          segmento as keyof typeof MODULE_TO_SUBJECT_ADMINISTRACION
        ];

      // The verb is one the catalog is known to use...
      expect(accion).toBeDefined();
      // ...and the key yields exactly that action on its own subject.
      const reglas = rulesFromPermissionKeys([id]);
      expect(createAppAbility(reglas).can(accion, sujeto)).toBe(true);
      expect(reglas.filter((r) => !r.inverted).map((r) => r.action)).toEqual([
        accion,
      ]);
    }
  });

  it('`x.depurar` sobre un segmento de Administración no concede nada', () => {
    for (const segmento of Object.keys(MODULE_TO_SUBJECT_ADMINISTRACION)) {
      expect(rulesFromPermissionKeys([`${segmento}.depurar`])).toEqual([]);
    }
    const ability = abilityFor(['pqr.depurar']);
    expect(ability.can('purge', 'Pqr')).toBe(false);
    expect(ability.can('read', 'Pqr')).toBe(false);
  });

  it('un verbo que se agregue solo a Finanzas tampoco llega a Administración', () => {
    const usados = new Set<string>(
      Object.keys(ACCION_POR_VERBO_ADMINISTRACION),
    );
    const soloFinanzas = Object.keys(VERB_TO_ACTION).filter(
      (verbo) =>
        !usados.has(verbo) && !(verbo in VERB_TO_ACTION_ADMINISTRACION),
    );

    // `depurar` is one today; anything added to VERB_TO_ACTION later lands here.
    expect(soloFinanzas).toContain('depurar');
    for (const verbo of soloFinanzas) {
      for (const segmento of Object.keys(MODULE_TO_SUBJECT_ADMINISTRACION)) {
        expect(rulesFromPermissionKeys([`${segmento}.${verbo}`])).toEqual([]);
      }
    }
  });
});

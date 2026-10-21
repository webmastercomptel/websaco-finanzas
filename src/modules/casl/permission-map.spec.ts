import { createAppAbility, ACTIONS } from './casl-ability.constants';
import {
  MODULE_TO_SUBJECT,
  VERB_TO_ACTION,
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

  it('gestionar concede todas las acciones sobre ese módulo únicamente', () => {
    const ability = abilityFor(['recibos.gestionar']);

    expect(ability.can('annul', 'Recibo')).toBe(true);
    expect(ability.can('create', 'Recibo')).toBe(true);
    expect(ability.can('read', 'Factura')).toBe(false);
  });
});

describe('vocabulario de autorización', () => {
  it('no existe la acción "eliminar" en el mapa de verbos', () => {
    // Ningún documento financiero se borra: si este test falla, alguien
    // reintrodujo el borrado físico por la puerta de atrás.
    expect(Object.keys(VERB_TO_ACTION)).not.toContain('eliminar');
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
    const ability = abilityFor(['parametros-facturacion.gestionar']);

    expect(ability.can('read', 'Factura')).toBe(false);
    expect(ability.can('read', 'ConceptoCobro')).toBe(false);
  });

  it('permisos de otros módulos no conceden acceso a Configuracion', () => {
    const ability = abilityFor(['facturas.ver', 'conceptos.gestionar']);

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
      'facturas.gestionar',
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
      'facturas.gestionar',
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
      'adicion-contabilidad.gestionar',
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
      'interfaz-comptable.gestionar',
    ]);

    expect(ability.can('read', 'Configuracion')).toBe(false);
    expect(ability.can('create', 'Configuracion')).toBe(false);
  });
});

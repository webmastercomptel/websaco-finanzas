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

  it('cubre los seis módulos financieros del backlog', () => {
    for (const modulo of [
      'facturas',
      'recibos',
      'notas-credito',
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

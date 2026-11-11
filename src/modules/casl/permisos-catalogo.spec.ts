import * as catalogo from './permisos-catalogo';
import {
  esPermisoAdministracion,
  esPermisoFinanzas,
  MARGEN_CLAVES_HEREDADAS,
  MAX_CLAVES_ASIGNABLES,
  moduloDePermiso,
  PERMISOS_FINANZAS,
  PERMISOS_ADMINISTRACION,
  permisosDesconocidos,
  puedeLeerMateria,
} from './permisos-catalogo';
import { createAppAbility } from './casl-ability.constants';
import { rulesFromPermissionKeys } from './permission-map';

describe('puedeLeerMateria', () => {
  it('ver, gestionar y los demás verbos que implican leer permiten leer la materia', () => {
    expect(puedeLeerMateria(['tareas.ver'], 'Tarea')).toBe(true);
    expect(puedeLeerMateria(['tareas.gestionar'], 'Tarea')).toBe(true);
  });

  it('sin la clave de esa materia no se puede leer', () => {
    expect(puedeLeerMateria(['pqr.ver'], 'Tarea')).toBe(false);
    expect(puedeLeerMateria([], 'Tarea')).toBe(false);
  });

  it('una clave de otro módulo no abre una materia ajena', () => {
    expect(puedeLeerMateria(['facturas.ver'], 'Anuncio')).toBe(false);
  });
});

describe('PERMISOS_ADMINISTRACION (catálogo que ofrece el editor de roles)', () => {
  const claves = PERMISOS_ADMINISTRACION.map((p) => p.id);

  it('tiene las 30 claves de Administración, sin repetir', () => {
    expect(claves).toHaveLength(30);
    expect(new Set(claves).size).toBe(30);
  });

  it('toda clave pertenece al módulo administracion y ninguna es de finanzas', () => {
    for (const clave of claves) {
      expect(moduloDePermiso(clave)).toBe('administracion');
    }
  });

  it('el módulo de documentos de Administración no choca con el de Finanzas', () => {
    expect(claves).toContain('documentos-administracion.ver');
    expect(claves.some((c) => c.startsWith('documentos.'))).toBe(false);
  });

  it('toda clave se traduce a una regla de CASL (ninguna queda muerta)', () => {
    for (const clave of claves) {
      expect(rulesFromPermissionKeys([clave]).length).toBeGreaterThan(0);
    }
  });

  it('eliminar usuarios, anuncios, etc. produce `remove`, nunca sobre una materia financiera', () => {
    const habilidad = createAppAbility(
      rulesFromPermissionKeys(['anuncios.eliminar']),
    );
    expect(habilidad.can('remove', 'Anuncio')).toBe(true);
    expect(habilidad.can('remove', 'Factura')).toBe(false);
  });

  it('roles.ver es una clave de Administración del grupo Configuración', () => {
    const entrada = PERMISOS_ADMINISTRACION.find((p) => p.id === 'roles.ver');

    expect(entrada).toBeDefined();
    expect(entrada?.modulo).toBe('Configuración');
    expect(moduloDePermiso('roles.ver')).toBe('administracion');
  });

  it('roles.ver solo permite leer roles; roles.gestionar sigue cubriéndolo todo', () => {
    const ver = createAppAbility(rulesFromPermissionKeys(['roles.ver']));
    expect(ver.can('read', 'Rol')).toBe(true);
    expect(ver.can('create', 'Rol')).toBe(false);
    expect(ver.can('update', 'Rol')).toBe(false);
    expect(ver.can('remove', 'Rol')).toBe(false);

    const gestionar = createAppAbility(
      rulesFromPermissionKeys(['roles.gestionar']),
    );
    for (const accion of ['read', 'create', 'update', 'remove'] as const) {
      expect(gestionar.can(accion, 'Rol')).toBe(true);
    }
  });

  it('esPermisoAdministracion acepta solo las claves del catálogo', () => {
    expect(esPermisoAdministracion('pqr.gestionar')).toBe(true);
    expect(esPermisoAdministracion('facturas.ver')).toBe(false);
    expect(esPermisoAdministracion('pqr.eliminar')).toBe(false);
    expect(esPermisoAdministracion('inventada.ver')).toBe(false);
  });
});

describe('moduloDePermiso', () => {
  it('toda clave conocida de hoy pertenece al módulo finanzas', () => {
    expect(moduloDePermiso('facturas.ver')).toBe('finanzas');
    expect(moduloDePermiso('interfaz-comptable.crear')).toBe('finanzas');
  });

  it('`gestionar` ya no es una clave de Finanzas pero sigue siendo de Administración', () => {
    expect(moduloDePermiso('facturas.gestionar')).toBeNull();
    expect(moduloDePermiso('recibos.gestionar')).toBeNull();
    expect(moduloDePermiso('pqr.gestionar')).toBe('administracion');
    expect(moduloDePermiso('roles.gestionar')).toBe('administracion');
  });

  it('`depurar` es un verbo de Finanzas y no existe en Administración', () => {
    expect(moduloDePermiso('facturas.depurar')).toBe('finanzas');
    expect(moduloDePermiso('inmuebles.depurar')).toBe('finanzas');
    expect(moduloDePermiso('pqr.depurar')).toBeNull();
  });

  it('una clave desconocida o mal formada no pertenece a ningún módulo', () => {
    expect(moduloDePermiso('inventado.ver')).toBeNull();
    expect(moduloDePermiso('facturas.eliminar')).toBeNull();
    expect(moduloDePermiso('facturas')).toBeNull();
  });
});

describe('permisosDesconocidos', () => {
  it('devuelve solo las claves que no existen en el catálogo', () => {
    expect(
      permisosDesconocidos(['facturas.ver', 'facturas.eliminar', 'x.ver']),
    ).toEqual(['facturas.eliminar', 'x.ver']);
  });

  it('un `gestionar` de Finanzas guardado de antes cuenta como desconocido', () => {
    expect(
      permisosDesconocidos(['facturas.gestionar', 'pqr.gestionar']),
    ).toEqual(['facturas.gestionar']);
  });
});

describe('el perfil ya no limita qué claves puede tener una fila', () => {
  it('no existe ningún veto por perfil: ni al escribir ni al leer', () => {
    expect(catalogo).not.toHaveProperty('permisosVetadosParaPerfil');
    expect(catalogo).not.toHaveProperty('sinPermisosVetados');
  });

  it('el perfil sigue siendo un dato de quién gestiona la fila', () => {
    expect([...catalogo.PERFILES_ASIGNACION]).toEqual([
      'administrativo',
      'personal',
    ]);
  });
});

describe('claves de Administración', () => {
  it('pertenecen al módulo administracion, incluidos sus verbos propios', () => {
    expect(moduloDePermiso('anuncios.ver')).toBe('administracion');
    expect(moduloDePermiso('anuncios.eliminar')).toBe('administracion');
    expect(moduloDePermiso('documentos-administracion.subir')).toBe(
      'administracion',
    );
    expect(moduloDePermiso('tareas.actualizar')).toBe('administracion');
  });

  it('una clave de Administración vale solo si está en el catálogo (una sola definición)', () => {
    // Gramaticalmente válidas, pero fuera del catálogo que ofrece el editor.
    for (const clave of [
      'usuarios.gestionar',
      'config.anular',
      'tareas.crear',
    ]) {
      expect(moduloDePermiso(clave)).toBeNull();
      expect(permisosDesconocidos([clave])).toEqual([clave]);
    }
  });

  it('un verbo propio de Administración no vale en un módulo financiero', () => {
    expect(moduloDePermiso('facturas.eliminar')).toBeNull();
    expect(moduloDePermiso('recibos.subir')).toBeNull();
  });
});

describe('MAX_CLAVES_ASIGNABLES (límite de claves de un cuerpo de Equipo o Roles)', () => {
  const ofrecidas = PERMISOS_FINANZAS.length + PERMISOS_ADMINISTRACION.length;

  it('se deriva de los catálogos más un margen, no es un literal', () => {
    expect(MAX_CLAVES_ASIGNABLES).toBe(ofrecidas + MARGEN_CLAVES_HEREDADAS);
  });

  it('nunca queda por debajo del catálogo ofrecido: una petición con todas las claves cabe', () => {
    expect(MAX_CLAVES_ASIGNABLES).toBeGreaterThanOrEqual(ofrecidas);
    expect(esPermisoFinanzas(PERMISOS_FINANZAS[0])).toBe(true);
  });

  it('hoy vale 116 = 56 de Finanzas + 30 de Administración + 30 de margen', () => {
    expect(PERMISOS_FINANZAS).toHaveLength(56);
    expect(PERMISOS_ADMINISTRACION).toHaveLength(30);
    expect(MARGEN_CLAVES_HEREDADAS).toBe(30);
    expect(MAX_CLAVES_ASIGNABLES).toBe(116);
  });

  it('el margen cubre las 17 claves `x.gestionar` de Finanzas que pueden viajar de vuelta antes de la limpieza', () => {
    const modulosFinanzas = new Set(
      PERMISOS_FINANZAS.map((c) => c.split('.')[0]),
    );
    expect(modulosFinanzas.size).toBeLessThanOrEqual(MARGEN_CLAVES_HEREDADAS);
    expect(MARGEN_CLAVES_HEREDADAS).toBeGreaterThanOrEqual(17);
  });
});

import {
  esPermisoAdministracion,
  moduloDePermiso,
  PERMISOS_ADMINISTRACION,
  permisosDesconocidos,
  permisosVetadosParaPerfil,
  puedeLeerMateria,
  sinPermisosVetados,
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

  it('tiene las 29 claves de Administración, sin repetir', () => {
    expect(claves).toHaveLength(29);
    expect(new Set(claves).size).toBe(29);
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
});

describe('techo duro por perfil', () => {
  const claves = ['facturas.ver', 'recibos.crear'];

  it('el personal operativo no puede tener ninguna clave de finanzas', () => {
    expect(permisosVetadosParaPerfil('personal', claves)).toEqual(claves);
  });

  it('el perfil administrativo no tiene vetos', () => {
    expect(permisosVetadosParaPerfil('administrativo', claves)).toEqual([]);
  });

  it('sinPermisosVetados recorta al leer: el personal queda sin claves de finanzas', () => {
    expect(sinPermisosVetados('personal', claves)).toEqual([]);
    expect(sinPermisosVetados('administrativo', claves)).toEqual(claves);
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
      'roles.ver',
    ]) {
      expect(moduloDePermiso(clave)).toBeNull();
      expect(permisosDesconocidos([clave])).toEqual([clave]);
    }
  });

  it('un verbo propio de Administración no vale en un módulo financiero', () => {
    expect(moduloDePermiso('facturas.eliminar')).toBeNull();
    expect(moduloDePermiso('recibos.subir')).toBeNull();
  });

  it('el personal operativo puede tener claves de Administración pero no de Finanzas', () => {
    const claves = ['anuncios.ver', 'pqr.gestionar', 'facturas.ver'];

    expect(permisosVetadosParaPerfil('personal', claves)).toEqual([
      'facturas.ver',
    ]);
    expect(sinPermisosVetados('personal', claves)).toEqual([
      'anuncios.ver',
      'pqr.gestionar',
    ]);
  });
});

import {
  moduloDePermiso,
  permisosDesconocidos,
  permisosVetadosParaPerfil,
  sinPermisosVetados,
} from './permisos-catalogo';

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

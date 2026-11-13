import { Types } from 'mongoose';
import { toAsignacionUsuario, toUsuario } from './usuarios.mapper';

/** A row as Mongoose hands it back after `.populate(..., 'nombre')`. */
const fila = (over: Record<string, unknown> = {}) => {
  const copId = new Types.ObjectId();
  return {
    _id: new Types.ObjectId(),
    accountId: new Types.ObjectId(),
    alcance: 'copropiedad',
    copropiedadId: { _id: copId, nombre: 'Edificio Central' },
    entidadId: null,
    perfil: 'administrativo',
    permisos: ['facturas.ver'],
    roleIds: [],
    estado: 'active',
    ...over,
  };
};

describe('toAsignacionUsuario', () => {
  it('lleva el id de la fila, el destino, el perfil, los permisos y el estado', () => {
    const doc = fila();

    expect(toAsignacionUsuario(doc as never)).toEqual({
      id: doc._id.toString(),
      alcance: 'copropiedad',
      copropiedadId: doc.copropiedadId._id.toString(),
      copropiedadNombre: 'Edificio Central',
      entidadId: null,
      entidadNombre: null,
      perfil: 'administrativo',
      permisos: ['facturas.ver'],
      estado: 'activo',
      cantidadRoles: 0,
    });
  });

  it('una fila inactiva se lee como inactivo', () => {
    expect(
      toAsignacionUsuario(fila({ estado: 'inactive' }) as never).estado,
    ).toBe('inactivo');
  });

  it('una fila antigua sin perfil se lee como administrativo (S-U1.2)', () => {
    const doc = fila();
    delete (doc as Record<string, unknown>).perfil;

    expect(toAsignacionUsuario(doc as never).perfil).toBe('administrativo');
  });

  it('los permisos van tal como están guardados, sin filtrar, y cuenta los roles (S-U1.3)', () => {
    const doc = fila({
      perfil: 'personal',
      permisos: ['facturas.ver', 'inmuebles.aprobar', 'tareas.volar'],
      roleIds: [new Types.ObjectId(), new Types.ObjectId()],
    });

    const item = toAsignacionUsuario(doc as never);

    expect(item.permisos).toEqual([
      'facturas.ver',
      'inmuebles.aprobar',
      'tareas.volar',
    ]);
    expect(item.cantidadRoles).toBe(2);
    expect(item.perfil).toBe('personal');
  });

  it('una fila de entidad cuenta 0 roles aunque guarde una lista (S-U1.7)', () => {
    const entId = new Types.ObjectId();
    const doc = fila({
      alcance: 'entidad',
      copropiedadId: null,
      entidadId: { _id: entId, nombre: 'Administradora Sur' },
      roleIds: [new Types.ObjectId()],
    });

    const item = toAsignacionUsuario(doc as never);

    expect(item.cantidadRoles).toBe(0);
    expect(item.entidadId).toBe(entId.toString());
    expect(item.entidadNombre).toBe('Administradora Sur');
    expect(item.copropiedadId).toBeNull();
    expect(item.copropiedadNombre).toBeNull();
  });

  it('sin roleIds guardados (fila antigua) cuenta 0', () => {
    const doc = fila();
    delete (doc as Record<string, unknown>).roleIds;

    expect(toAsignacionUsuario(doc as never).cantidadRoles).toBe(0);
  });

  it('un destino que ya no se resuelve conserva el id crudo y el nombre queda null (S-U1.6)', () => {
    const copId = new Types.ObjectId();
    // Mongoose sets an unresolved populated path to null; the original id is
    // still reachable through `populated()`.
    const doc = fila({
      copropiedadId: null,
      populated: (ruta: string) => (ruta === 'copropiedadId' ? copId : null),
    });

    const item = toAsignacionUsuario(doc as never);

    expect(item.copropiedadId).toBe(copId.toString());
    expect(item.copropiedadNombre).toBeNull();
  });

  it('un id sin poblar (ObjectId) se devuelve como texto, con nombre null', () => {
    const copId = new Types.ObjectId();
    const item = toAsignacionUsuario(fila({ copropiedadId: copId }) as never);

    expect(item.copropiedadId).toBe(copId.toString());
    expect(item.copropiedadNombre).toBeNull();
  });

  it('un destino que se borró y ya no tiene ni id queda en null sin romper', () => {
    const item = toAsignacionUsuario(fila({ copropiedadId: null }) as never);

    expect(item.copropiedadId).toBeNull();
    expect(item.copropiedadNombre).toBeNull();
  });
});

describe('toUsuario — asignaciones', () => {
  const cuenta = {
    _id: new Types.ObjectId(),
    nombreCompleto: 'Ana Pérez',
    email: 'ana@ejemplo.com',
    esAdministradorPlataforma: false,
    estado: 'active',
  } as never;

  it('asignaciones conserva el orden recibido, activas e inactivas, de todos los perfiles', () => {
    const a = fila({ estado: 'active' });
    const b = fila({ estado: 'inactive' });
    const c = fila({ perfil: 'personal' });

    const usuario = toUsuario(cuenta, [a, b, c] as never);

    expect(usuario.asignaciones.map((x) => x.id)).toEqual([
      a._id.toString(),
      b._id.toString(),
      c._id.toString(),
    ]);
  });

  it('no lleva la clave `asignacion`: asignaciones[] es la única representación (S-X2.1, S-X2.2)', () => {
    const usuario = toUsuario(cuenta, [
      fila({ estado: 'active' }),
      fila({ estado: 'inactive' }),
    ] as never);

    expect(usuario).not.toHaveProperty('asignacion');
    expect(Object.keys(usuario).sort()).toEqual([
      'asignaciones',
      'email',
      'esAdministradorPlataforma',
      'estado',
      'id',
      'nombre',
    ]);
  });

  it('sin filas: asignaciones [] (S-U1.5)', () => {
    expect(toUsuario(cuenta, []).asignaciones).toEqual([]);
  });

  it('solo filas inactivas: asignaciones las lista todas', () => {
    const usuario = toUsuario(cuenta, [fila({ estado: 'inactive' })] as never);

    expect(usuario.asignaciones).toHaveLength(1);
  });
});

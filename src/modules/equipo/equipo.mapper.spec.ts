import { Types } from 'mongoose';
import { toMiembroEquipo } from './equipo.mapper';

const cuenta = {
  nombreCompleto: 'Ana',
  email: 'ana@x.co',
  esAdministradorPlataforma: false,
  estado: 'active' as const,
};

describe('toMiembroEquipo', () => {
  const rolId = new Types.ObjectId();
  const roles = new Map([
    [rolId.toString(), { id: rolId.toString(), nombre: 'Portero' }],
  ]);

  it('un miembro personal activo es editable y lleva el nombre de sus roles', () => {
    const m = toMiembroEquipo(
      {
        _id: new Types.ObjectId(),
        perfil: 'personal',
        estado: 'active',
        permisos: ['tareas.ver'],
        roleIds: [rolId, new Types.ObjectId()],
      },
      cuenta,
      roles,
    );
    expect(m).toMatchObject({
      perfil: 'personal',
      estado: 'activo',
      editable: true,
    });
    expect(m.roles).toEqual([{ id: rolId.toString(), nombre: 'Portero' }]);
  });

  it('una fila sin perfil se lee como administrativa y no editable', () => {
    const m = toMiembroEquipo(
      { _id: new Types.ObjectId(), estado: 'active', permisos: [] },
      cuenta,
      roles,
    );
    expect(m.perfil).toBe('administrativo');
    expect(m.editable).toBe(false);
  });

  it('administrador de plataforma: no editable; cuenta o asignación inactiva: inactivo', () => {
    const base = {
      _id: new Types.ObjectId(),
      perfil: 'personal' as const,
      permisos: [],
    };
    expect(
      toMiembroEquipo(
        { ...base, estado: 'active' },
        { ...cuenta, esAdministradorPlataforma: true },
        roles,
      ).editable,
    ).toBe(false);
    expect(
      toMiembroEquipo({ ...base, estado: 'inactive' }, cuenta, roles).estado,
    ).toBe('inactivo');
    expect(
      toMiembroEquipo(
        { ...base, estado: 'active' },
        { ...cuenta, estado: 'inactive' },
        roles,
      ).estado,
    ).toBe('inactivo');
  });
});

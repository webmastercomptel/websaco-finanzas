import { Types } from 'mongoose';
import {
  accionesDesdeUsuarios,
  estadoAlReactivar,
} from './asignaciones-usuario.reglas';

describe('accionesDesdeUsuarios — supuesto 1: las filas del equipo son de solo lectura', () => {
  it('una fila personal no se edita, ni se desactiva, ni se reactiva desde Usuarios', () => {
    expect(accionesDesdeUsuarios('personal')).toEqual({
      editarClaves: false,
      desactivar: false,
      reactivar: false,
    });
  });

  it('una fila administrativa permite las tres acciones', () => {
    expect(accionesDesdeUsuarios('administrativo')).toEqual({
      editarClaves: true,
      desactivar: true,
      reactivar: true,
    });
  });
});

describe('estadoAlReactivar — supuesto 3: vuelve como administrativa y sin roles', () => {
  it('devuelve perfil administrativo y roleIds vacío aunque la fila tuviera roles', () => {
    const fila = { roleIds: [new Types.ObjectId(), new Types.ObjectId()] };

    expect(estadoAlReactivar(fila)).toEqual({
      perfil: 'administrativo',
      roleIds: [],
    });
  });

  it('una fila antigua sin roleIds también da []', () => {
    expect(estadoAlReactivar({})).toEqual({
      perfil: 'administrativo',
      roleIds: [],
    });
  });
});

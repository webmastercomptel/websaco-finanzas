import { cuentaAdmiteSesionPorEnlace } from './politica-enlace';

const activa = { estado: 'active', esAdministradorPlataforma: false };
const acceso = (permissions: string[]) => ({ permissions });

describe('cuentaAdmiteSesionPorEnlace', () => {
  it('admite una cuenta activa, sin Finanzas y con solo filas personal', () => {
    expect(
      cuentaAdmiteSesionPorEnlace({
        cuenta: activa,
        accesos: [acceso(['tareas.ver']), acceso([])],
        tieneNoPersonal: false,
      }),
    ).toBe(true);
  });

  it('admite a un residente sin ningún acceso de personal', () => {
    expect(
      cuentaAdmiteSesionPorEnlace({
        cuenta: activa,
        accesos: [acceso([])],
        tieneNoPersonal: false,
      }),
    ).toBe(true);
    expect(
      cuentaAdmiteSesionPorEnlace({
        cuenta: activa,
        accesos: [],
        tieneNoPersonal: false,
      }),
    ).toBe(true);
  });

  it('SEC: nunca para un administrador de la plataforma', () => {
    expect(
      cuentaAdmiteSesionPorEnlace({
        cuenta: { ...activa, esAdministradorPlataforma: true },
        accesos: [],
        tieneNoPersonal: false,
      }),
    ).toBe(false);
  });

  it('SEC: nunca para una cuenta inactiva', () => {
    expect(
      cuentaAdmiteSesionPorEnlace({
        cuenta: { ...activa, estado: 'inactive' },
        accesos: [],
        tieneNoPersonal: false,
      }),
    ).toBe(false);
  });

  it('SEC: nunca con una clave de Finanzas en cualquiera de sus accesos', () => {
    expect(
      cuentaAdmiteSesionPorEnlace({
        cuenta: activa,
        accesos: [acceso(['tareas.ver']), acceso(['facturas.ver'])],
        tieneNoPersonal: false,
      }),
    ).toBe(false);
  });

  it('SEC: nunca con una fila que no sea personal (administrativo o de entidad) en ningún lugar', () => {
    expect(
      cuentaAdmiteSesionPorEnlace({
        cuenta: activa,
        accesos: [acceso(['tareas.ver'])],
        tieneNoPersonal: true,
      }),
    ).toBe(false);
  });
});

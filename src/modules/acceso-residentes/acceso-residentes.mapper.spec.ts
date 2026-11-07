import { Types } from 'mongoose';
import {
  correoDeInvitacion,
  toResidenteAcceso,
} from './acceso-residentes.mapper';

describe('correoDeInvitacion', () => {
  it('toma el primer correo válido, recortado y en minúsculas', () => {
    expect(correoDeInvitacion(['x', ' Dos@Correo.CO ', 'tres@correo.co'])).toBe(
      'dos@correo.co',
    );
  });
  it('devuelve null sin correos válidos', () => {
    expect(correoDeInvitacion([])).toBeNull();
    expect(correoDeInvitacion(undefined)).toBeNull();
    expect(correoDeInvitacion(['', 'sin-arroba'])).toBeNull();
  });
});

describe('toResidenteAcceso', () => {
  const t = {
    _id: new Types.ObjectId(),
    nombre: 'Ana',
    emails: ['a@x.co'],
    accountId: null,
  };

  it('sin cuenta y con correo es aprovisionable', () => {
    expect(toResidenteAcceso(t, [], null)).toMatchObject({
      estadoAcceso: 'sinCuenta',
      aprovisionable: true,
      email: 'a@x.co',
    });
  });
  it('con cuenta activa o inactiva, nunca expone el id de la cuenta', () => {
    const cuentaId = new Types.ObjectId();
    const activa = toResidenteAcceso({ ...t, accountId: cuentaId }, [], true);
    const inactiva = toResidenteAcceso(
      { ...t, accountId: cuentaId },
      [],
      false,
    );
    expect(activa.estadoAcceso).toBe('conCuenta');
    expect(inactiva.estadoAcceso).toBe('cuentaInactiva');
    expect(activa.aprovisionable).toBe(false);
    expect(JSON.stringify(activa)).not.toContain(cuentaId.toString());
  });
});

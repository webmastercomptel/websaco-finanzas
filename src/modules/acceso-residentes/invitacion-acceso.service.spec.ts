import { Types } from 'mongoose';
import { InvitacionAccesoService } from './invitacion-acceso.service';

const solicitud = {
  accountId: new Types.ObjectId().toString(),
  email: 'ana@correo.co',
  nombre: 'Ana',
  copropiedadId: new Types.ObjectId(),
  tipo: 'residente' as const,
  cuentaExistente: false,
  destino: '/portal',
};

function montar(
  over: {
    configurado?: boolean;
    enlace?: string | null;
    enviado?: boolean;
  } = {},
) {
  const correo = {
    estaConfigurado: jest.fn(() => over.configurado ?? true),
    enviar: jest.fn().mockResolvedValue(over.enviado ?? true),
  };
  const enlaces = {
    construir: jest
      .fn()
      .mockResolvedValue(
        over.enlace === undefined ? 'https://x/e' : over.enlace,
      ),
  };
  const copropiedades = {
    findById: jest.fn(() => ({
      select: () => ({
        lean: () => ({ exec: () => Promise.resolve({ nombre: 'Edificio' }) }),
      }),
    })),
  };
  return {
    correo,
    enlaces,
    servicio: new InvitacionAccesoService(
      correo as never,
      enlaces as never,
      copropiedades as never,
    ),
  };
}

describe('InvitacionAccesoService', () => {
  it('envía con botón cuando hay enlace', async () => {
    const m = montar();
    expect(await m.servicio.enviar(solicitud)).toEqual({
      invitacionEnviada: true,
      enlaceIncluido: true,
    });
    expect(m.enlaces.construir).toHaveBeenCalledWith(
      solicitud.accountId,
      solicitud.copropiedadId.toString(),
      '/portal',
    );
  });

  it('sin enlace envía igual pero declara enlaceIncluido false', async () => {
    const m = montar({ enlace: null });
    expect(await m.servicio.enviar(solicitud)).toEqual({
      invitacionEnviada: true,
      enlaceIncluido: false,
    });
  });

  it('sin correo configurado no emite enlace ni envía', async () => {
    const m = montar({ configurado: false });
    expect(await m.servicio.enviar(solicitud)).toEqual({
      invitacionEnviada: false,
      enlaceIncluido: false,
    });
    expect(m.enlaces.construir).not.toHaveBeenCalled();
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('si el proveedor rechaza el envío lo informa sin lanzar', async () => {
    const m = montar({ enviado: false });
    expect(await m.servicio.enviar(solicitud)).toEqual({
      invitacionEnviada: false,
      enlaceIncluido: false,
    });
  });

  it('nunca lanza aunque falle la preparación', async () => {
    const m = montar();
    m.enlaces.construir.mockRejectedValueOnce(new Error('boom'));
    expect(await m.servicio.enviar(solicitud)).toEqual({
      invitacionEnviada: false,
      enlaceIncluido: false,
    });
  });
});

import {
  BadGatewayException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { claveCorreo } from '../../common/utils/email.utils';
import { montar as montarIngreso } from '../ingreso-portal/testing/montar-servicio';
import {
  COP,
  OTRA_COP,
  USUARIO,
  cuenta,
  montar,
  tercero,
  type Opciones,
} from './testing/montar-residentes-correos';

const user = USUARIO as IRequestUser;
const CLAVE_ANA = claveCorreo('ana@correo.co');

/**
 * The resend over a REAL `IngresoPortalService` (its own stand-ins for the
 * residency queries, the link store, the mail and the counters), so the mail
 * that goes out is the very one a self-service request would send.
 */
const escenario = (
  over: Opciones = {},
  ingresoOver: Parameters<typeof montarIngreso>[0] = {},
) => {
  const ana = tercero({ emails: ['ana@correo.co', 'Segunda@Correo.co'] });
  const ingreso = montarIngreso({
    copropiedades: new Map([[COP.toString(), [ana._id.toString()]]]),
    contador: new Map(),
    ...ingresoOver,
  });
  const m = montar({
    terceros: [ana],
    ...over,
    ingreso: ingreso.servicio,
  });
  return { ana, ingreso, ...m };
};

describe('ResidentesCorreosService.reenviar', () => {
  it('SEC: staff resend only mails the named record address', async () => {
    const { ana, ingreso, servicio } = escenario();

    const r = await servicio.reenviar(
      {
        terceroId: ana._id.toString(),
        clave: claveCorreo('segunda@correo.co'),
      },
      user,
    );

    expect(r).toEqual({ enviado: true });
    expect(ingreso.correo.enviar).toHaveBeenCalledTimes(1);
    const mensaje = ingreso.correo.enviar.mock.calls[0][0] as {
      para: string;
      html: string;
    };
    // The address is the one on the record behind the clave, nothing else.
    expect(mensaje.para).toBe('segunda@correo.co');
    expect(mensaje.html).toMatch(/\/ingreso#[0-9a-f]{64}/);
    // A fresh token, the staff origin, and older links killed only after the send.
    expect(ingreso.enlaces.crear).toHaveBeenCalledWith({
      correo: 'segunda@correo.co',
      origen: 'personal',
      solicitadoPor: new Types.ObjectId(USUARIO.accountId),
    });
    expect(
      ingreso.eventos.filter((e) =>
        ['crear', 'enviar', 'confirmar'].includes(e),
      ),
    ).toEqual(['crear', 'enviar', 'confirmar']);
  });

  it('el correo del resend no lleva /auth/enlace ni token= (S-R5.4)', async () => {
    const { ana, ingreso, servicio } = escenario();
    await servicio.reenviar(
      { terceroId: ana._id.toString(), clave: CLAVE_ANA },
      user,
    );
    const { html } = ingreso.correo.enviar.mock.calls[0][0] as { html: string };
    expect(html).not.toContain('/auth/enlace');
    expect(html).not.toContain('token=');
  });

  it('una pareja que ya no está en la ficha es 404 y no envía nada', async () => {
    const { ana, ingreso, servicio } = escenario();
    await expect(
      servicio.reenviar(
        {
          terceroId: ana._id.toString(),
          clave: claveCorreo('quitado@correo.co'),
        },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ingreso.correo.enviar).not.toHaveBeenCalled();
    expect(ingreso.enlaces.crear).not.toHaveBeenCalled();
  });

  it('un tercero de otra copropiedad es 404 aunque el correo coincida', async () => {
    const ajena = tercero({ copropiedadId: OTRA_COP });
    const { ingreso, servicio } = escenario({ terceros: [ajena] });
    await expect(
      servicio.reenviar(
        { terceroId: ajena._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ingreso.correo.enviar).not.toHaveBeenCalled();
  });

  it('el acceso heredado cuyo correo salió de la ficha no se reenvía: solo se manda a una dirección de la ficha', async () => {
    const vieja = cuenta({ email: 'viejo@correo.co' });
    const t = tercero({ emails: ['nuevo@correo.co'], accountId: vieja._id });
    const { ingreso, servicio } = escenario({
      terceros: [t],
      cuentas: [vieja],
    });
    await expect(
      servicio.reenviar(
        { terceroId: t._id.toString(), clave: claveCorreo('viejo@correo.co') },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ingreso.correo.enviar).not.toHaveBeenCalled();
  });

  it('un correo revocado en esta copropiedad: 409 con la razón y sin correo', async () => {
    const { ana, ingreso, servicio } = escenario({ revocadas: [CLAVE_ANA] });
    await expect(
      servicio.reenviar(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toThrow(
      new ConflictException(
        'Esa persona no puede entrar: su acceso está revocado.',
      ),
    );
    expect(ingreso.correo.enviar).not.toHaveBeenCalled();
    expect(ingreso.enlaces.crear).not.toHaveBeenCalled();
  });

  it.each([
    [
      'revocado en todas',
      { revocadas: [COP.toString()] },
      {},
      'Esa persona no puede entrar: su acceso está revocado.',
    ],
    [
      'cuenta inactiva',
      {},
      { cuenta: { estado: 'inactive' as const } },
      'Esa persona no puede entrar: su cuenta está inactiva.',
    ],
    [
      'sin unidad activa',
      {},
      { copropiedades: new Map<string, string[]>() },
      'Esa persona no puede entrar: su correo no está en una ficha con una unidad activa.',
    ],
  ])(
    'no elegible (%s): 409 con su frase y sin correo',
    async (_nombre, ingresoOver, extra, frase) => {
      const { ana, ingreso, servicio } = escenario(
        {},
        {
          ...ingresoOver,
          ...extra,
        },
      );
      await expect(
        servicio.reenviar(
          { terceroId: ana._id.toString(), clave: CLAVE_ANA },
          user,
        ),
      ).rejects.toThrow(new ConflictException(frase));
      expect(ingreso.correo.enviar).not.toHaveBeenCalled();
    },
  );

  it('un buzón compartido (más de tres fichas): 409 que pide corregir las fichas', async () => {
    const { ana, ingreso, servicio } = escenario(
      {},
      { copropiedades: new Map<string, string[]>() },
    );
    ingreso.residencia.motivosCorreoGenerico.mockResolvedValue(
      new Map([['ana@correo.co', 'correo-compartido']]),
    );
    await expect(
      servicio.reenviar(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toThrow(
      new ConflictException(
        'Esa persona no puede entrar: su correo está en demasiadas fichas. Corrígelo en Terceros.',
      ),
    );
    expect(ingreso.correo.enviar).not.toHaveBeenCalled();
  });

  it('comparte los contadores por correo del reenvío: el 4.º en 15 minutos es motivo limite', async () => {
    const { ana, ingreso, servicio } = escenario();
    const dto = { terceroId: ana._id.toString(), clave: CLAVE_ANA };

    for (let i = 0; i < 3; i += 1) {
      await expect(servicio.reenviar(dto, user)).resolves.toEqual({
        enviado: true,
      });
    }
    await expect(servicio.reenviar(dto, user)).resolves.toEqual({
      enviado: false,
      motivo: 'limite',
    });

    expect(ingreso.correo.enviar).toHaveBeenCalledTimes(3);
    // The staff counter is its own: no self-service key is ever touched.
    expect(
      ingreso.llamadasPermitir.every((k) =>
        k.startsWith('limite:ingreso-reenvio:'),
      ),
    ).toBe(true);
    expect(JSON.stringify(ingreso.llamadasPermitir)).not.toContain(
      'ana@correo.co',
    );
  });

  it('un rechazo por elegibilidad no gasta el contador', async () => {
    const { ana, ingreso, servicio } = escenario({ revocadas: [CLAVE_ANA] });
    await expect(
      servicio.reenviar(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(ingreso.limite.permitir).not.toHaveBeenCalled();
  });

  it('sin correo configurado: enviado false con su motivo, ningún enlace y ninguna auditoría', async () => {
    const { ana, ingreso, servicio, entradasAuditoria } = escenario(
      {},
      { configurado: false },
    );
    await expect(
      servicio.reenviar(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).resolves.toEqual({ enviado: false, motivo: 'sin-correo-configurado' });
    expect(ingreso.enlaces.crear).not.toHaveBeenCalled();
    expect(entradasAuditoria).toHaveLength(0);
  });

  it('si el proveedor rechaza el envío: 502, el enlace nuevo se anula y no hay auditoría', async () => {
    const { ana, ingreso, servicio, entradasAuditoria } = escenario(
      {},
      { enviado: false },
    );
    await expect(
      servicio.reenviar(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(ingreso.enlaces.anular).toHaveBeenCalledTimes(1);
    expect(ingreso.enlaces.confirmarEnvio).not.toHaveBeenCalled();
    expect(entradasAuditoria).toHaveLength(0);
  });

  it('audita `enviar` una vez por envío, en una transacción, sin el correo', async () => {
    const {
      ana,
      servicio,
      entradasAuditoria,
      connection,
      sesiones,
      auditoria,
    } = escenario();
    await servicio.reenviar(
      { terceroId: ana._id.toString(), clave: CLAVE_ANA },
      user,
    );
    await servicio.reenviar(
      { terceroId: ana._id.toString(), clave: CLAVE_ANA },
      user,
    );

    expect(entradasAuditoria).toHaveLength(2);
    expect(entradasAuditoria[0]).toMatchObject({
      accion: 'enviar',
      entidadTipo: 'acceso-residente',
      entidadId: ana._id.toString(),
      actorAccountId: USUARIO.accountId,
    });
    const etiqueta = entradasAuditoria[0].entidadEtiqueta as string;
    expect(etiqueta).toContain('Ana Pérez');
    expect(etiqueta).toContain(COP.toString());
    expect(JSON.stringify(entradasAuditoria)).not.toContain('correo.co');
    expect(connection.startSession).toHaveBeenCalledTimes(2);
    expect(auditoria.registrar.mock.calls[0][1]).toBe(sesiones[0]);
  });

  it('si la auditoría falla después de enviar, el envío se informa igual y el log no lleva el correo', async () => {
    const espia = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { ana, ingreso, servicio } = escenario({ auditoriaFalla: true });
    await expect(
      servicio.reenviar(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).resolves.toEqual({ enviado: true });
    expect(ingreso.correo.enviar).toHaveBeenCalledTimes(1);
    const impreso = JSON.stringify(espia.mock.calls);
    expect(espia).toHaveBeenCalled();
    expect(impreso).not.toContain('correo.co');
    espia.mockRestore();
  });
});

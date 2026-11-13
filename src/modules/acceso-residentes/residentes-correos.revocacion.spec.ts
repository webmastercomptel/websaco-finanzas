import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ResidenciaService } from '../../common/acceso/residencia.service';
import { claveCorreo } from '../../common/utils/email.utils';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import {
  COP,
  OTRA_COP,
  USUARIO,
  cuenta,
  montar,
  tercero,
} from './testing/montar-residentes-correos';

const CLAVE_ANA = claveCorreo('ana@correo.co');
const user = USUARIO as IRequestUser;

/** A party of the active coproperty carrying one address, and the world around it. */
const escenario = (over: Parameters<typeof montar>[0] = {}) => {
  const ana = tercero();
  const m = montar({ terceros: [ana], ...over });
  return { ana, ...m };
};

describe('ResidentesCorreosService.revocar', () => {
  it('SEC: foreign party or unmatched clave is a 404', async () => {
    const ajena = tercero({ copropiedadId: OTRA_COP });
    const { ana, servicio, modeloRevocaciones, auditoria } = escenario({
      terceros: [ajena, tercero()],
    });

    // A party of another coproperty, even with the right address.
    await expect(
      servicio.revocar(
        { terceroId: ajena._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // A clave that is not on that party's record.
    await expect(
      servicio.revocar(
        { terceroId: ana._id.toString(), clave: claveCorreo('otro@x.co') },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // A malformed or unknown id.
    await expect(
      servicio.revocar({ terceroId: 'no-es-id', clave: CLAVE_ANA }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      servicio.revocar(
        { terceroId: new Types.ObjectId().toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(modeloRevocaciones.create).not.toHaveBeenCalled();
    expect(auditoria.registrar).not.toHaveBeenCalled();
  });

  it('re-resuelve la ficha en la copropiedad activa (id y copropiedadId)', async () => {
    const { ana, servicio, filtrosTerceros } = escenario();
    await servicio.revocar(
      { terceroId: ana._id.toString(), clave: CLAVE_ANA },
      user,
    );
    expect(filtrosTerceros[0]).toMatchObject({ copropiedadId: COP });
    expect(String(filtrosTerceros[0]._id)).toBe(ana._id.toString());
  });

  it('inserta la revocación activa y la auditoría `retirar` en UNA transacción, sin el correo', async () => {
    const {
      ana,
      servicio,
      modeloRevocaciones,
      entradasAuditoria,
      connection,
      sesiones,
      auditoria,
    } = escenario();

    const r = await servicio.revocar(
      { terceroId: ana._id.toString(), clave: CLAVE_ANA },
      user,
    );

    expect(r).toEqual({ terceroId: ana._id.toString(), clave: CLAVE_ANA });
    expect(connection.startSession).toHaveBeenCalledTimes(1);
    expect(modeloRevocaciones.filas).toHaveLength(1);
    const fila = modeloRevocaciones.filas[0];
    expect(Object.keys(fila).sort()).toEqual(
      [
        '_id',
        'activa',
        'clave',
        'copropiedadId',
        'revocadaEn',
        'revocadaPor',
      ].sort(),
    );
    expect(fila).toMatchObject({ clave: CLAVE_ANA, activa: true });
    expect(String(fila.copropiedadId)).toBe(COP.toString());
    expect(String(fila.revocadaPor)).toBe(USUARIO.accountId);
    expect(JSON.stringify(fila)).not.toContain('ana@correo.co');

    expect(entradasAuditoria).toHaveLength(1);
    expect(entradasAuditoria[0]).toMatchObject({
      accion: 'retirar',
      entidadTipo: 'acceso-residente',
      entidadId: String(fila._id),
      actorAccountId: USUARIO.accountId,
      actorNombre: 'Admin Edificio',
    });
    const etiqueta = entradasAuditoria[0].entidadEtiqueta as string;
    expect(etiqueta).toContain('Ana Pérez');
    expect(etiqueta).toContain(COP.toString());
    expect(JSON.stringify(entradasAuditoria)).not.toContain('ana@correo.co');
    // The audit write travels in the same session as the revocation.
    const sesion = modeloRevocaciones.create.mock.calls[0][1]?.session;
    expect(sesion).toBe(sesiones[0]);
    expect(auditoria.registrar.mock.calls[0][1]).toBe(sesion);
  });

  it('revocar dos veces: 200, una sola entrada de auditoría y se queda el quién/cuándo del primero', async () => {
    const { ana, servicio, modeloRevocaciones, entradasAuditoria } =
      escenario();
    const dto = { terceroId: ana._id.toString(), clave: CLAVE_ANA };
    await servicio.revocar(dto, user);
    const primera = { ...modeloRevocaciones.filas[0] };

    const otro = { ...user, accountId: new Types.ObjectId().toString() };
    await expect(servicio.revocar(dto, otro)).resolves.toEqual(dto);

    expect(modeloRevocaciones.filas).toHaveLength(1);
    expect(modeloRevocaciones.filas[0]).toEqual(primera);
    expect(entradasAuditoria).toHaveLength(1);
  });

  it('una auditoría que falla no deja la revocación', async () => {
    const { ana, servicio, modeloRevocaciones, entradasAuditoria } = escenario({
      auditoriaFalla: true,
    });
    await expect(
      servicio.revocar(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toThrow('audit down');
    expect(modeloRevocaciones.filas).toHaveLength(0);
    expect(entradasAuditoria).toHaveLength(0);
  });

  it('no toca Firebase, la ficha, la cuenta ni ninguna otra copropiedad', async () => {
    const { ana, servicio, modeloTerceros, modeloCuentas, modeloRevocaciones } =
      escenario();
    await servicio.revocar(
      { terceroId: ana._id.toString(), clave: CLAVE_ANA },
      user,
    );
    expect(modeloTerceros.updateOne).not.toHaveBeenCalled();
    expect(modeloTerceros.updateMany).not.toHaveBeenCalled();
    expect(modeloCuentas.updateOne).not.toHaveBeenCalled();
    expect(modeloCuentas.create).not.toHaveBeenCalled();
    expect(modeloCuentas.findOneAndUpdate).not.toHaveBeenCalled();
    expect(
      modeloRevocaciones.filas.every(
        (f) => String(f.copropiedadId) === COP.toString(),
      ),
    ).toBe(true);
  });

  it('acepta un correo guardado con espacios: la clave es la del valor recortado', async () => {
    const padded = tercero({ emails: ['  ana@correo.co '] });
    const { servicio, modeloRevocaciones } = montar({ terceros: [padded] });
    await servicio.revocar(
      { terceroId: padded._id.toString(), clave: CLAVE_ANA },
      user,
    );
    expect(modeloRevocaciones.filas[0]).toMatchObject({ clave: CLAVE_ANA });
  });

  it('S-R1.8: un acceso heredado cuyo correo ya no está en la ficha se puede revocar, sin desvincular', async () => {
    const vieja = cuenta({ email: 'viejo@correo.co' });
    const t = tercero({ emails: ['nuevo@correo.co'], accountId: vieja._id });
    const { servicio, modeloRevocaciones, modeloTerceros } = montar({
      terceros: [t],
      cuentas: [vieja],
    });

    await servicio.revocar(
      { terceroId: t._id.toString(), clave: claveCorreo('viejo@correo.co') },
      user,
    );

    expect(modeloRevocaciones.filas[0]).toMatchObject({
      clave: claveCorreo('viejo@correo.co'),
      activa: true,
    });
    expect(modeloTerceros.updateOne).not.toHaveBeenCalled();
  });

  it('una clave de OTRA cuenta no se acepta aunque la ficha tenga una cuenta vinculada', async () => {
    const vieja = cuenta({ email: 'viejo@correo.co' });
    const t = tercero({ emails: ['nuevo@correo.co'], accountId: vieja._id });
    const { servicio } = montar({ terceros: [t], cuentas: [vieja] });
    await expect(
      servicio.revocar(
        { terceroId: t._id.toString(), clave: claveCorreo('ajeno@correo.co') },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ResidentesCorreosService.permitir', () => {
  const revocada = (over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    copropiedadId: COP,
    clave: CLAVE_ANA,
    activa: true,
    revocadaPor: new Types.ObjectId(),
    revocadaEn: new Date('2026-10-01T00:00:00.000Z'),
    levantadaPor: null,
    levantadaEn: null,
    ...over,
  });

  it('levanta la revocación con un update condicional y audita `restablecer`', async () => {
    const previa = revocada();
    const { ana, servicio, modeloRevocaciones, entradasAuditoria, connection } =
      escenario({ revocaciones: [previa] });

    const r = await servicio.permitir(
      { terceroId: ana._id.toString(), clave: CLAVE_ANA },
      user,
    );

    expect(r).toEqual({ terceroId: ana._id.toString(), clave: CLAVE_ANA });
    const [filtro, cambio] = modeloRevocaciones.findOneAndUpdate.mock
      .calls[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(filtro).toEqual({
      copropiedadId: COP,
      clave: CLAVE_ANA,
      activa: true,
    });
    expect(cambio.$set).toMatchObject({ activa: false });
    expect(String(cambio.$set.levantadaPor)).toBe(USUARIO.accountId);
    expect(cambio.$set.levantadaEn).toBeInstanceOf(Date);
    // History stays: the row is still there, lifted.
    expect(modeloRevocaciones.filas).toHaveLength(1);
    expect(modeloRevocaciones.filas[0]).toMatchObject({
      activa: false,
      revocadaPor: previa.revocadaPor,
    });
    expect(connection.startSession).toHaveBeenCalledTimes(1);
    expect(entradasAuditoria).toEqual([
      expect.objectContaining({
        accion: 'restablecer',
        entidadTipo: 'acceso-residente',
        entidadId: String(previa._id),
      }),
    ]);
    expect(JSON.stringify(entradasAuditoria)).not.toContain('ana@correo.co');
  });

  it('un correo que no está revocado: 200, sin escritura y sin auditoría', async () => {
    const { ana, servicio, modeloRevocaciones, entradasAuditoria } =
      escenario();
    await expect(
      servicio.permitir(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).resolves.toEqual({ terceroId: ana._id.toString(), clave: CLAVE_ANA });
    expect(modeloRevocaciones.filas).toHaveLength(0);
    expect(entradasAuditoria).toHaveLength(0);
  });

  it('SEC: foreign party or unmatched clave is a 404 también al permitir', async () => {
    const ajena = tercero({ copropiedadId: OTRA_COP });
    const { ana, servicio, modeloRevocaciones } = escenario({
      terceros: [ajena, tercero()],
      revocaciones: [revocada()],
    });
    await expect(
      servicio.permitir(
        { terceroId: ajena._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      servicio.permitir(
        { terceroId: ana._id.toString(), clave: claveCorreo('otro@x.co') },
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(modeloRevocaciones.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('una auditoría que falla deja la revocación como estaba', async () => {
    const { ana, servicio, modeloRevocaciones } = escenario({
      revocaciones: [revocada()],
      auditoriaFalla: true,
    });
    await expect(
      servicio.permitir(
        { terceroId: ana._id.toString(), clave: CLAVE_ANA },
        user,
      ),
    ).rejects.toThrow('audit down');
    expect(modeloRevocaciones.filas[0]).toMatchObject({ activa: true });
  });

  it('revocar, permitir y revocar: historial de tres eventos (dos filas, una levantada y una activa); el acceso vuelve sin canjear', async () => {
    const {
      ana,
      servicio,
      modeloRevocaciones,
      modeloCuentas,
      entradasAuditoria,
    } = escenario();
    const dto = { terceroId: ana._id.toString(), clave: CLAVE_ANA };
    // The real residency query over the same store the service writes to.
    const residencia = new ResidenciaService(
      {} as never,
      {} as never,
      {} as never,
      modeloRevocaciones as never,
    );
    const activas = () =>
      residencia.revocacionesActivas(CLAVE_ANA, [
        COP.toString(),
        OTRA_COP.toString(),
      ]);

    await servicio.revocar(dto, user);
    expect([...(await activas())]).toEqual([COP.toString()]);

    await servicio.permitir(dto, user);
    expect([...(await activas())]).toEqual([]);

    await servicio.revocar(dto, user);
    expect([...(await activas())]).toEqual([COP.toString()]);

    // One row per revoke event: the lifted one keeps who and when it was lifted.
    expect(modeloRevocaciones.filas).toHaveLength(2);
    expect(modeloRevocaciones.filas[0]).toMatchObject({ activa: false });
    expect(modeloRevocaciones.filas[0].levantadaPor).toBeDefined();
    expect(
      modeloRevocaciones.filas.filter((f) => f.activa === true),
    ).toHaveLength(1);
    expect(entradasAuditoria.map((e) => e.accion)).toEqual([
      'retirar',
      'restablecer',
      'retirar',
    ]);
    // Access is derived from the unchanged proof on the Account: re-allow
    // writes nothing there, so nothing has to be redeemed again.
    expect(modeloCuentas.updateOne).not.toHaveBeenCalled();
    expect(modeloCuentas.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('revocar y permitir un acceso heredado deja intacto el vínculo de la ficha', async () => {
    const vieja = cuenta({ email: 'viejo@correo.co' });
    const t = tercero({ emails: ['viejo@correo.co'], accountId: vieja._id });
    const { servicio, modeloTerceros } = montar({
      terceros: [t],
      cuentas: [vieja],
    });
    const dto = {
      terceroId: t._id.toString(),
      clave: claveCorreo('viejo@correo.co'),
    };
    await servicio.revocar(dto, user);
    await servicio.permitir(dto, user);
    expect(modeloTerceros.updateOne).not.toHaveBeenCalled();
    expect(modeloTerceros.updateMany).not.toHaveBeenCalled();
  });
});

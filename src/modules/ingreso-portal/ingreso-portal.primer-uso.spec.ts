import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Types } from 'mongoose';
import { uidDeResidente } from '../../common/firebase/uid-residente';
import { ColeccionMemoria } from '../envio-facturas/testing/coleccion-memoria';
import {
  CLAVE,
  COPRO_A,
  CORREO,
  montar,
  TOKEN,
} from './testing/montar-servicio';

const UID = uidDeResidente(CORREO);

const conTienda = (over: Parameters<typeof montar>[0] = {}) => {
  const cuentas = new ColeccionMemoria(['email']);
  const m = montar({ cuentasEnMemoria: cuentas, cuenta: null, ...over });
  return { m, cuentas };
};

describe('IngresoPortalService.crearCuentaPrimerUso', () => {
  it('creates the identity FIRST, then the Account and its audit entry in one transaction', async () => {
    const { m, cuentas } = conTienda();

    const resultado = await m.servicio.canjear(TOKEN);

    expect(resultado).toEqual({
      resultado: 'sesion',
      customToken: `custom-token-de-${UID}`,
    });
    expect(m.firebase.crearIdentidadResidente).toHaveBeenCalledWith(UID);
    expect(UID).toBe(`rc1_${CLAVE}`);
    // Order: identity, then the transaction opens, then the audit entry.
    const i = m.eventos;
    expect(i.indexOf('identidad')).toBeLessThan(i.indexOf('transaccion'));
    expect(i.indexOf('transaccion')).toBeLessThan(i.indexOf('auditoria'));
    // The audit write received the transaction's session.
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.anything(),
      m.sesiones[0],
    );
    expect(cuentas.docs).toHaveLength(1);
  });

  it('the Account is the address, active, not admin, named after a party, bound to the identity', async () => {
    const { m, cuentas } = conTienda();

    await m.servicio.canjear(TOKEN);

    expect(cuentas.docs[0]).toMatchObject({
      email: CORREO,
      firebaseUid: UID,
      nombreCompleto: 'Ana Propietaria',
      estado: 'active',
      esAdministradorPlataforma: false,
    });
    // The display name is a party's name, never the address.
    expect(String(cuentas.docs[0].nombreCompleto)).not.toContain('@');
  });

  it('writes no Asignacion and no Tercero.accountId, and sets no password', async () => {
    const { m } = conTienda();

    await m.servicio.canjear(TOKEN);

    // Only read collaborators exist for those collections; any write would throw.
    expect(Object.keys(m.asignaciones)).toEqual(['exists']);
    expect(Object.keys(m.terceros)).toEqual(['findOne']);
    expect(Object.keys(m.firebase)).toEqual(['crearIdentidadResidente']);
  });

  it('audits the creation: crear / acceso-residente, actor = the new account, party and coproperty in the label', async () => {
    const { m, cuentas } = conTienda();

    await m.servicio.canjear(TOKEN);

    expect(m.entradasAuditoria).toHaveLength(1);
    const entrada = m.entradasAuditoria[0];
    const idCuenta = String(cuentas.docs[0]._id);
    expect(entrada).toMatchObject({
      accion: 'crear',
      entidadTipo: 'acceso-residente',
      actorAccountId: idCuenta,
      entidadId: idCuenta,
      actorNombre: 'Ana Propietaria',
    });
    expect(entrada.entidadEtiqueta).toContain('Ana Propietaria');
    expect(entrada.entidadEtiqueta).toContain(COPRO_A);
  });

  it('SEC: no audit label, detail or Account field carries the address or the token', async () => {
    const { m, cuentas } = conTienda();

    await m.servicio.canjear(TOKEN);

    const auditado = JSON.stringify(m.entradasAuditoria).toLowerCase();
    expect(auditado).not.toContain('example.com');
    expect(auditado).not.toContain(TOKEN);
    expect(auditado).not.toContain(CLAVE);
    expect(m.entradasAuditoria[0]).not.toHaveProperty('detalle');
    // The Account legitimately holds the address (it is its unique key).
    expect(cuentas.docs[0].email).toBe(CORREO);
  });

  it('a failed audit write saves no Account, and the retry meets "no account" again', async () => {
    const { m, cuentas } = conTienda();
    m.auditoria.registrar.mockRejectedValueOnce(new Error('audit down'));

    expect(await m.servicio.canjear(TOKEN)).toBeNull();
    expect(cuentas.docs).toHaveLength(0);
    expect(m.entradasAuditoria).toHaveLength(0);

    // Retry (a new link): the identity already exists, the Account is created.
    expect(await m.servicio.canjear(TOKEN)).toMatchObject({
      resultado: 'sesion',
    });
    expect(cuentas.docs).toHaveLength(1);
    expect(m.entradasAuditoria).toHaveLength(1);
    expect(m.firebase.crearIdentidadResidente).toHaveBeenCalledTimes(2);
  });

  it('a failed identity creation saves nothing and audits nothing', async () => {
    const { m, cuentas } = conTienda({ identidadFalla: true });

    expect(await m.servicio.canjear(TOKEN)).toBeNull();

    expect(cuentas.docs).toHaveLength(0);
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
    expect(m.connection.startSession).not.toHaveBeenCalled();
  });

  it('no party carries the address any more: nothing is created, not even the identity', async () => {
    const { m, cuentas } = conTienda({ nombreTercero: null });

    expect(await m.servicio.canjear(TOKEN)).toBeNull();

    expect(m.firebase.crearIdentidadResidente).not.toHaveBeenCalled();
    expect(cuentas.docs).toHaveLength(0);
  });

  it('SEC: concurrent first use creates one account', async () => {
    const { m, cuentas } = conTienda({ accesos: [] });

    const resultados = await Promise.all([
      m.servicio.canjear(TOKEN),
      m.servicio.canjear(TOKEN),
      m.servicio.canjear(TOKEN),
    ]);

    expect(cuentas.docs).toHaveLength(1);
    expect(m.entradasAuditoria).toHaveLength(1);
    // The losers re-read the winner's Account and also get a session for it.
    for (const resultado of resultados) {
      expect(resultado).toEqual({
        resultado: 'sesion',
        customToken: `custom-token-de-${UID}`,
      });
    }
    // The same inert identity every time, never a second one.
    for (const [uid] of m.firebase.crearIdentidadResidente.mock
      .calls as string[][]) {
      expect(uid).toBe(UID);
    }
  });

  it('a duplicate on the address that cannot be re-read is not swallowed', async () => {
    const { m, cuentas } = conTienda();
    jest
      .spyOn(cuentas, 'create')
      .mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
      );

    expect(await m.servicio.canjear(TOKEN)).toBeNull();
  });

  it('the proof is recorded on the new Account', async () => {
    const { m, cuentas } = conTienda({ accesos: [] });

    await m.servicio.canjear(TOKEN);

    expect(cuentas.docs[0].correoProbadoClave).toBe(CLAVE);
    expect(cuentas.docs[0].ultimoIngresoPortalEn).toBeInstanceOf(Date);
  });

  it('the request and a refused redeem write no audit entry', async () => {
    const solicitud = montar();
    await solicitud.servicio.solicitar(CORREO);
    const rechazo = montar({ fila: null });
    await rechazo.servicio.canjear(TOKEN);
    const inelegible = montar({ copropiedades: new Map() });
    await inelegible.servicio.canjear(TOKEN);

    expect(solicitud.auditoria.registrar).not.toHaveBeenCalled();
    expect(rechazo.auditoria.registrar).not.toHaveBeenCalled();
    expect(inelegible.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('an existing Account is never given a second audit entry or a second identity', async () => {
    const { m } = conTienda({ accesos: [] });
    await m.servicio.canjear(TOKEN);
    m.firebase.crearIdentidadResidente.mockClear();

    await m.servicio.canjear(TOKEN);

    expect(m.firebase.crearIdentidadResidente).not.toHaveBeenCalled();
    expect(m.entradasAuditoria).toHaveLength(1);
  });

  it('createUser appears only inside FirebaseUsuariosService (no password flow anywhere in the portal sign-in)', () => {
    const raiz = join(__dirname, '..', '..');
    const archivos = (
      readdirSync(raiz, { recursive: true }) as string[]
    ).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    const conCreateUser = archivos
      .filter((f) => /\bcreateUser\b/.test(readFileSync(join(raiz, f), 'utf8')))
      .map((f) => relative(raiz, join(raiz, f)).split(sep).join('/'));

    expect(conCreateUser).toEqual([
      'common/firebase/firebase-usuarios.service.ts',
    ]);

    const modulo = join(__dirname);
    for (const f of readdirSync(modulo).filter(
      (n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'),
    )) {
      const fuente = readFileSync(join(modulo, f), 'utf8');
      // No password is ever set, sent or asked for by this flow.
      expect(fuente).not.toMatch(/actualizarPassword|password\s*:/i);
    }
  });

  it('keeps the new account id distinct from any id of the link or the party', async () => {
    const { m, cuentas } = conTienda();

    await m.servicio.canjear(TOKEN);

    expect(Types.ObjectId.isValid(String(cuentas.docs[0]._id))).toBe(true);
    expect(String(cuentas.docs[0]._id)).not.toBe(m.terceroId);
  });
});

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import type { IRequestUser } from '../../common/interfaces/request-user.interface';
import { AccesoResidentesService } from './acceso-residentes.service';
import { InvitacionAccesoService } from './invitacion-acceso.service';

const COP = new Types.ObjectId();
const OTRA_COP = new Types.ObjectId();

const USER: IRequestUser = {
  uid: 'uid-admin',
  email: 'admin@edificio.co',
  accountId: new Types.ObjectId().toString(),
  nombre: 'Admin Edificio',
  permissions: ['usuarios.ver', 'usuarios.crear'],
};

interface TerceroFake {
  _id: Types.ObjectId;
  copropiedadId: Types.ObjectId;
  nombre: string;
  emails: string[];
  accountId: Types.ObjectId | null;
  estado: 'active' | 'inactive';
}

interface CuentaFake {
  _id: Types.ObjectId;
  firebaseUid: string;
  email: string;
  nombreCompleto: string;
  esAdministradorPlataforma: boolean;
  estado: 'active' | 'inactive';
}

const tercero = (over: Partial<TerceroFake> = {}): TerceroFake => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  nombre: 'Ana Pérez',
  emails: ['ana@correo.co'],
  accountId: null,
  estado: 'active',
  ...over,
});

const cuenta = (over: Partial<CuentaFake> = {}): CuentaFake => ({
  _id: new Types.ObjectId(),
  firebaseUid: 'uid-existente',
  email: 'ana@correo.co',
  nombreCompleto: 'Ana Pérez',
  esAdministradorPlataforma: false,
  estado: 'active',
  ...over,
});

const mismoId = (a: unknown, b: unknown): boolean => String(a) === String(b);

/** Minimal Mongo-filter evaluator, enough for the filters this service writes. */
const coincide = (
  item: Record<string, unknown>,
  filtro: Record<string, unknown>,
): boolean =>
  Object.entries(filtro).every(([clave, cond]) => {
    if (clave === '$and') {
      return (cond as Record<string, unknown>[]).every((f) =>
        coincide(item, f),
      );
    }
    if (clave === '$or') {
      return (cond as Record<string, unknown>[]).some((f) => coincide(item, f));
    }
    const valor = item[clave];
    if (cond === null) return valor == null;
    if (cond instanceof Types.ObjectId) return mismoId(valor, cond);
    if (typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('$in' in c && !(c.$in as unknown[]).some((x) => mismoId(x, valor)))
        return false;
      if ('$gt' in c && !(String(valor) > String(c.$gt))) return false;
      if ('$ne' in c) {
        if (c.$ne === null ? valor == null : mismoId(valor, c.$ne))
          return false;
      }
      if ('$regex' in c) {
        const re = new RegExp(String(c.$regex), 'i');
        const texto = Array.isArray(valor)
          ? valor.join(' ')
          : typeof valor === 'string'
            ? valor
            : '';
        if (!re.test(texto)) return false;
      }
      return true;
    }
    return valor === cond;
  });

const consulta = <T>(resultado: () => T) => {
  const q = {
    select: () => q,
    sort: () => q,
    skip: () => q,
    limit: () => q,
    lean: () => q,
    exec: () => Promise.resolve(resultado()),
  };
  return q;
};

interface Opciones {
  terceros?: TerceroFake[];
  cuentas?: CuentaFake[];
  unidades?: Array<{
    codigo: string;
    titular?: TerceroFake;
    arrendatario?: TerceroFake;
  }>;
  personal?: Types.ObjectId[]; // accounts holding an Asignacion
  correoConfigurado?: boolean;
  enlace?: string | null;
  /** Emails Firebase already knows (conflict on create). */
  firebaseConoce?: string[];
  /** Makes Account.create fail once for this email (cut-off after the identity). */
  falloGuardarCuenta?: string[];
  retraso?: number;
}

function montar(opciones: Opciones = {}) {
  const storeTerceros = opciones.terceros ?? [];
  const storeCuentas = opciones.cuentas ?? [];
  const personal = new Set((opciones.personal ?? []).map(String));
  const identidades = new Set<string>(opciones.firebaseConoce ?? []);
  const falloGuardar = new Set(opciones.falloGuardarCuenta ?? []);
  const passwords: string[] = [];
  const enviados: Array<{ para: string; asunto: string; html: string }> = [];
  let activos = 0;
  let maxActivos = 0;

  const unidades = (opciones.unidades ?? []).map((u) => ({
    _id: new Types.ObjectId(),
    codigo: u.codigo,
    titularId: u.titular?._id ?? null,
    arrendatarioId: u.arrendatario?._id ?? null,
  }));

  const tercerosModel = {
    find: jest.fn((f: Record<string, unknown>) =>
      consulta(() => storeTerceros.filter((t) => coincide(t as never, f))),
    ),
    findOne: jest.fn((f: Record<string, unknown>) =>
      consulta(
        () => storeTerceros.find((t) => coincide(t as never, f)) ?? null,
      ),
    ),
    countDocuments: jest.fn((f: Record<string, unknown>) =>
      consulta(
        () => storeTerceros.filter((t) => coincide(t as never, f)).length,
      ),
    ),
    exists: jest.fn((f: Record<string, unknown>) =>
      consulta(
        () => storeTerceros.find((t) => coincide(t as never, f)) ?? null,
      ),
    ),
    updateOne: jest.fn(
      (
        f: Record<string, unknown>,
        u: { $set: { accountId: Types.ObjectId | null } },
      ) =>
        consulta(() => {
          const t = storeTerceros.find((x) => coincide(x as never, f));
          if (!t) return { matchedCount: 0 };
          t.accountId = u.$set.accountId;
          return { matchedCount: 1 };
        }),
    ),
  };
  const inmueblesModel = { find: jest.fn(() => consulta(() => unidades)) };
  const cuentasModel = {
    findOne: jest.fn((f: { email: string }) =>
      consulta(() => storeCuentas.find((c) => c.email === f.email) ?? null),
    ),
    findById: jest.fn((id: Types.ObjectId) =>
      consulta(() => storeCuentas.find((c) => mismoId(c._id, id)) ?? null),
    ),
    find: jest.fn((f: { _id: { $in: Types.ObjectId[] } }) =>
      consulta(() =>
        storeCuentas.filter((c) => f._id.$in.some((i) => mismoId(i, c._id))),
      ),
    ),
    create: jest.fn((doc: Omit<CuentaFake, '_id'>) => {
      if (falloGuardar.delete(doc.email))
        return Promise.reject(new Error('mongo caído'));
      const nueva = { _id: new Types.ObjectId(), ...doc };
      storeCuentas.push(nueva);
      return Promise.resolve(nueva);
    }),
    updateOne: jest.fn(),
    deleteOne: jest.fn(),
    findByIdAndDelete: jest.fn(),
  };
  const asignacionesModel = {
    exists: jest.fn((f: { accountId: Types.ObjectId }) =>
      consulta(() => (personal.has(String(f.accountId)) ? { _id: 'x' } : null)),
    ),
    create: jest.fn(),
  };
  const firebase = {
    crear: jest.fn(
      async (d: { email: string; password: string; nombre: string }) => {
        activos += 1;
        maxActivos = Math.max(maxActivos, activos);
        await new Promise((r) => setTimeout(r, opciones.retraso ?? 0));
        activos -= 1;
        passwords.push(d.password);
        if (identidades.has(d.email)) {
          throw new ConflictException(
            `Ya existe una cuenta de Firebase con el correo ${d.email}.`,
          );
        }
        identidades.add(d.email);
        return { uid: `uid-${identidades.size}-${d.email}` };
      },
    ),
    establecerHabilitado: jest.fn(),
    actualizarPassword: jest.fn(),
  };
  const correo = {
    estaConfigurado: jest.fn(() => opciones.correoConfigurado ?? true),
    enviar: jest.fn((m: { para: string; asunto: string; html: string }) => {
      enviados.push(m);
      return Promise.resolve(true);
    }),
  };
  const enlaces = {
    construir: jest.fn(() =>
      Promise.resolve(
        opciones.enlace === undefined
          ? 'https://app.co/auth/enlace?token=abc'
          : opciones.enlace,
      ),
    ),
  };
  const copropiedadesModel = {
    findById: jest.fn(() => consulta(() => ({ nombre: 'Edificio Central' }))),
  };
  const auditoria = { registrar: jest.fn().mockResolvedValue(undefined) };
  const tenant = { resolveCoPropertyId: jest.fn(() => COP) };

  const invitaciones = new InvitacionAccesoService(
    correo as never,
    enlaces as never,
    copropiedadesModel as never,
  );
  const servicio = new AccesoResidentesService(
    tercerosModel as never,
    inmueblesModel as never,
    cuentasModel as never,
    firebase as never,
    tenant as never,
    invitaciones,
    auditoria as never,
  );
  return {
    servicio,
    tercerosModel,
    cuentasModel,
    asignacionesModel,
    firebase,
    correo,
    enlaces,
    auditoria,
    storeTerceros,
    storeCuentas,
    identidades,
    passwords,
    enviados,
    maxActivos: () => maxActivos,
  };
}

describe('AccesoResidentesService.crearAcceso', () => {
  it('crea la identidad con una contraseña aleatoria, la cuenta sin asignación, el vínculo y la auditoría', async () => {
    const t = tercero({ emails: ['  ANA@Correo.CO '] });
    const m = montar({ terceros: [t] });

    const r = await m.servicio.crearAcceso(t._id.toString(), {}, USER);

    expect(m.firebase.crear).toHaveBeenCalledTimes(1);
    const llamada = m.firebase.crear.mock.calls[0][0];
    expect(llamada.email).toBe('ana@correo.co');
    expect(llamada.password.length).toBeGreaterThanOrEqual(32);
    expect(llamada.password).not.toContain('ana');
    expect(m.cuentasModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'ana@correo.co',
        nombreCompleto: 'Ana Pérez',
        esAdministradorPlataforma: false,
        estado: 'active',
      }),
    );
    // A resident gets NO assignment: access derives from the Tercero link.
    expect(m.asignacionesModel.create).not.toHaveBeenCalled();
    expect(t.accountId).not.toBeNull();
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        actorAccountId: USER.accountId,
        accion: 'crear',
        entidadTipo: 'usuario',
      }),
    );
    expect(r).toEqual({
      terceroId: t._id.toString(),
      cuentaExistente: false,
      invitacionEnviada: true,
      enlaceIncluido: true,
    });
  });

  it('la contraseña aleatoria no aparece en el correo ni en la respuesta', async () => {
    const t = tercero();
    const m = montar({ terceros: [t] });

    const r = await m.servicio.crearAcceso(t._id.toString(), {}, USER);

    const [password] = m.passwords;
    expect(password).toBeTruthy();
    expect(m.enviados).toHaveLength(1);
    expect(m.enviados[0].html).not.toContain(password);
    expect(m.enviados[0].asunto).not.toContain(password);
    expect(JSON.stringify(r)).not.toContain(password);
    expect(JSON.stringify(m.auditoria.registrar.mock.calls)).not.toContain(
      password,
    );
  });

  it('envía la invitación al correo del tercero con el botón de acceso al portal', async () => {
    const t = tercero();
    const m = montar({ terceros: [t] });

    await m.servicio.crearAcceso(t._id.toString(), {}, USER);

    expect(m.enlaces.construir).toHaveBeenCalledWith(
      expect.any(String),
      COP.toString(),
      '/portal',
    );
    expect(m.enviados[0].para).toBe('ana@correo.co');
    expect(m.enviados[0].html).toContain(
      'https://app.co/auth/enlace?token=abc',
    );
  });

  it('sin correo configurado crea la cuenta, no envía ni emite enlace y lo dice', async () => {
    const t = tercero();
    const m = montar({ terceros: [t], correoConfigurado: false });

    const r = await m.servicio.crearAcceso(t._id.toString(), {}, USER);

    expect(t.accountId).not.toBeNull();
    expect(m.correo.enviar).not.toHaveBeenCalled();
    expect(m.enlaces.construir).not.toHaveBeenCalled();
    expect(r.invitacionEnviada).toBe(false);
    expect(r.enlaceIncluido).toBe(false);
  });

  it('si no puede emitirse el enlace envía la invitación sin botón y lo informa', async () => {
    const t = tercero();
    const m = montar({ terceros: [t], enlace: null });

    const r = await m.servicio.crearAcceso(t._id.toString(), {}, USER);

    expect(r.invitacionEnviada).toBe(true);
    expect(r.enlaceIncluido).toBe(false);
    expect(m.enviados[0].html).not.toContain('<a href');
  });

  it('un tercero de otra copropiedad es 404 y no toca Firebase', async () => {
    const ajeno = tercero({ copropiedadId: OTRA_COP });
    const m = montar({ terceros: [ajeno] });

    await expect(
      m.servicio.crearAcceso(ajeno._id.toString(), {}, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(m.firebase.crear).not.toHaveBeenCalled();
    expect(ajeno.accountId).toBeNull();
  });

  it('un id mal formado es 404', async () => {
    const m = montar();
    await expect(
      m.servicio.crearAcceso('no-es-un-id', {}, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un tercero inactivo es 404', async () => {
    const t = tercero({ estado: 'inactive' });
    const m = montar({ terceros: [t] });
    await expect(
      m.servicio.crearAcceso(t._id.toString(), {}, USER),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sin correo válido es 409 y no crea nada', async () => {
    const t = tercero({ emails: ['no-es-correo', ''] });
    const m = montar({ terceros: [t] });

    await expect(
      m.servicio.crearAcceso(t._id.toString(), {}, USER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.firebase.crear).not.toHaveBeenCalled();
  });

  it('usa el PRIMER correo válido de la lista', async () => {
    const t = tercero({
      emails: ['basura', 'Segundo@Correo.co', 'tercero@correo.co'],
    });
    const m = montar({ terceros: [t] });

    await m.servicio.crearAcceso(t._id.toString(), {}, USER);

    expect(m.firebase.crear.mock.calls[0][0].email).toBe('segundo@correo.co');
  });

  it('un tercero que ya tiene cuenta vinculada es 409', async () => {
    const t = tercero({ accountId: new Types.ObjectId() });
    const m = montar({ terceros: [t] });
    await expect(
      m.servicio.crearAcceso(t._id.toString(), {}, USER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.firebase.crear).not.toHaveBeenCalled();
  });

  it('si Firebase ya conoce el correo (sin cuenta local) responde 409 y no crea cuenta', async () => {
    const t = tercero();
    const m = montar({ terceros: [t], firebaseConoce: ['ana@correo.co'] });

    await expect(
      m.servicio.crearAcceso(
        t._id.toString(),
        { vincularExistente: true },
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.cuentasModel.create).not.toHaveBeenCalled();
    expect(t.accountId).toBeNull();
  });

  it('si el vínculo pierde la carrera (matchedCount 0) responde 409', async () => {
    const t = tercero();
    const m = montar({ terceros: [t] });
    m.tercerosModel.updateOne.mockReturnValueOnce(
      consulta(() => ({ matchedCount: 0 })),
    );

    await expect(
      m.servicio.crearAcceso(t._id.toString(), {}, USER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('si el índice único {copropiedad, cuenta} salta, responde 409', async () => {
    const t = tercero();
    const m = montar({ terceros: [t] });
    m.tercerosModel.updateOne.mockReturnValueOnce({
      exec: () =>
        Promise.reject(Object.assign(new Error('dup'), { code: 11000 })),
    } as never);

    await expect(
      m.servicio.crearAcceso(t._id.toString(), {}, USER),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('AccesoResidentesService.crearAcceso con una cuenta que ya existe', () => {
  it('sin vincularExistente es 409: nunca se adueña de la cuenta en silencio', async () => {
    const t = tercero();
    const m = montar({ terceros: [t], cuentas: [cuenta()] });

    await expect(
      m.servicio.crearAcceso(t._id.toString(), {}, USER),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(t.accountId).toBeNull();
    expect(m.firebase.crear).not.toHaveBeenCalled();
    expect(m.auditoria.registrar).not.toHaveBeenCalled();
  });

  it('el 409 lleva el código estable CUENTA_EXISTENTE y conserva el mensaje', async () => {
    const t = tercero();
    const m = montar({ terceros: [t], cuentas: [cuenta()] });

    const error = await m.servicio
      .crearAcceso(t._id.toString(), {}, USER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'CUENTA_EXISTENTE',
      message: expect.stringContaining('vincularExistente') as string,
    });
  });

  it('con vincularExistente vincula la cuenta existente, sin tocar Firebase', async () => {
    const t = tercero();
    const c = cuenta();
    const m = montar({ terceros: [t], cuentas: [c] });

    const r = await m.servicio.crearAcceso(
      t._id.toString(),
      { vincularExistente: true },
      USER,
    );

    expect(r.cuentaExistente).toBe(true);
    expect(t.accountId).toEqual(c._id);
    expect(m.firebase.crear).not.toHaveBeenCalled();
    expect(m.cuentasModel.create).not.toHaveBeenCalled();
    expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
    expect(m.auditoria.registrar).toHaveBeenCalledTimes(1);
  });

  it('vincula una cuenta que tiene una Asignacion: los permisos suman y la vinculacion no toca la asignacion (S-A5.4)', async () => {
    const t = tercero();
    const c = cuenta();
    const m = montar({ terceros: [t], cuentas: [c], personal: [c._id] });

    const r = await m.servicio.crearAcceso(
      t._id.toString(),
      { vincularExistente: true },
      USER,
    );

    expect(r.cuentaExistente).toBe(true);
    expect(t.accountId).toEqual(c._id);
    expect(m.asignacionesModel.create).not.toHaveBeenCalled();
    expect(m.firebase.crear).not.toHaveBeenCalled();
  });

  it('rechaza (409) vincular una cuenta inactiva (S-A5.6)', async () => {
    const t = tercero();
    const m = montar({
      terceros: [t],
      cuentas: [cuenta({ estado: 'inactive' })],
    });

    await expect(
      m.servicio.crearAcceso(
        t._id.toString(),
        { vincularExistente: true },
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(t.accountId).toBeNull();
  });

  it('rechaza (409) vincular un administrador de la plataforma', async () => {
    const t = tercero();
    const m = montar({
      terceros: [t],
      cuentas: [cuenta({ esAdministradorPlataforma: true })],
    });

    await expect(
      m.servicio.crearAcceso(
        t._id.toString(),
        { vincularExistente: true },
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(t.accountId).toBeNull();
  });

  it('rechaza (409) vincular una cuenta inactiva', async () => {
    const t = tercero();
    const m = montar({
      terceros: [t],
      cuentas: [cuenta({ estado: 'inactive' })],
    });

    await expect(
      m.servicio.crearAcceso(
        t._id.toString(),
        { vincularExistente: true },
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza (409) si la cuenta ya está vinculada a OTRO tercero de la copropiedad', async () => {
    const c = cuenta();
    const otro = tercero({
      nombre: 'Otro',
      emails: ['otro@x.co'],
      accountId: c._id,
    });
    const t = tercero();
    const m = montar({ terceros: [t, otro], cuentas: [c] });

    await expect(
      m.servicio.crearAcceso(
        t._id.toString(),
        { vincularExistente: true },
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(t.accountId).toBeNull();
  });

  it('el correo de la invitación a una cuenta existente tampoco lleva contraseña', async () => {
    const t = tercero();
    const m = montar({ terceros: [t], cuentas: [cuenta()] });

    await m.servicio.crearAcceso(
      t._id.toString(),
      { vincularExistente: true },
      USER,
    );

    expect(m.enviados[0].html).toContain('contraseña de siempre');
    expect(m.passwords).toHaveLength(0);
  });
});

describe('AccesoResidentesService.reenviarInvitacion', () => {
  it('envía al correo de la CUENTA, no al que diga hoy el tercero', async () => {
    const c = cuenta({ email: 'cuenta@real.co' });
    const t = tercero({ emails: ['cambiado@otro.co'], accountId: c._id });
    const m = montar({ terceros: [t], cuentas: [c] });

    const r = await m.servicio.reenviarInvitacion(t._id.toString());

    expect(m.enviados[0].para).toBe('cuenta@real.co');
    expect(r.invitacionEnviada).toBe(true);
    expect(m.firebase.crear).not.toHaveBeenCalled();
  });

  it('un tercero sin acceso es 409', async () => {
    const t = tercero();
    const m = montar({ terceros: [t] });
    await expect(
      m.servicio.reenviarInvitacion(t._id.toString()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('una cuenta inactiva es 409', async () => {
    const c = cuenta({ estado: 'inactive' });
    const t = tercero({ accountId: c._id });
    const m = montar({ terceros: [t], cuentas: [c] });
    await expect(
      m.servicio.reenviarInvitacion(t._id.toString()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(m.correo.enviar).not.toHaveBeenCalled();
  });

  it('un tercero de otra copropiedad es 404', async () => {
    const c = cuenta();
    const ajeno = tercero({ copropiedadId: OTRA_COP, accountId: c._id });
    const m = montar({ terceros: [ajeno], cuentas: [c] });
    await expect(
      m.servicio.reenviarInvitacion(ajeno._id.toString()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sin correo configurado informa que no se envió', async () => {
    const c = cuenta();
    const t = tercero({ accountId: c._id });
    const m = montar({ terceros: [t], cuentas: [c], correoConfigurado: false });
    expect(await m.servicio.reenviarInvitacion(t._id.toString())).toEqual({
      invitacionEnviada: false,
      enlaceIncluido: false,
    });
  });
});

describe('AccesoResidentesService.desvincular', () => {
  it('limpia el vínculo, audita y nunca toca la cuenta ni Firebase', async () => {
    const c = cuenta();
    const t = tercero({ accountId: c._id });
    const m = montar({ terceros: [t], cuentas: [c] });

    await m.servicio.desvincular(t._id.toString(), USER);

    expect(t.accountId).toBeNull();
    expect(m.cuentasModel.updateOne).not.toHaveBeenCalled();
    expect(m.cuentasModel.deleteOne).not.toHaveBeenCalled();
    expect(m.cuentasModel.findByIdAndDelete).not.toHaveBeenCalled();
    expect(m.firebase.establecerHabilitado).not.toHaveBeenCalled();
    expect(m.firebase.actualizarPassword).not.toHaveBeenCalled();
    expect(m.auditoria.registrar).toHaveBeenCalledWith(
      expect.objectContaining({
        accion: 'retirar',
        entidadTipo: 'usuario',
        entidadId: c._id.toString(),
      }),
    );
  });

  it('el tercero sin acceso es 409; el de otra copropiedad 404', async () => {
    const sin = tercero();
    const c = cuenta();
    const ajeno = tercero({ copropiedadId: OTRA_COP, accountId: c._id });
    const m = montar({ terceros: [sin, ajeno], cuentas: [c] });

    await expect(
      m.servicio.desvincular(sin._id.toString(), USER),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      m.servicio.desvincular(ajeno._id.toString(), USER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(ajeno.accountId).toEqual(c._id);
  });
});

describe('AccesoResidentesService.aprovisionar', () => {
  const residentes = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      tercero({ nombre: `Residente ${i}`, emails: [`r${i}@correo.co`] }),
    );
  const conUnidades = (ts: TerceroFake[]) =>
    ts.map((t, i) => ({ codigo: `A-${i}`, titular: t }));

  it('crea el acceso de los terceros elegibles y devuelve el resumen', async () => {
    const ts = residentes(3);
    const m = montar({ terceros: ts, unidades: conUnidades(ts) });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r).toMatchObject({
      procesados: 3,
      creados: 3,
      omitidos: [],
      errores: [],
      pendientes: 0,
      siguienteDesde: null,
      invitacionesEnviadas: 3,
      correoConfigurado: true,
    });
    expect(ts.every((t) => t.accountId !== null)).toBe(true);
    expect(m.auditoria.registrar).toHaveBeenCalledTimes(3);
    expect(m.asignacionesModel.create).not.toHaveBeenCalled();
  });

  it('ignora a quien ya tiene cuenta, no tiene correo válido, no tiene unidad o es de otra copropiedad', async () => {
    const elegible = tercero({ emails: ['ok@correo.co'] });
    const conCuenta = tercero({
      emails: ['a@x.co'],
      accountId: new Types.ObjectId(),
    });
    const sinCorreo = tercero({ emails: ['basura'] });
    const sinUnidad = tercero({ emails: ['b@x.co'] });
    const ajeno = tercero({ copropiedadId: OTRA_COP, emails: ['c@x.co'] });
    const m = montar({
      terceros: [elegible, conCuenta, sinCorreo, sinUnidad, ajeno],
      unidades: conUnidades([elegible, conCuenta, sinCorreo, ajeno]),
    });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r.procesados).toBe(1);
    expect(m.firebase.crear).toHaveBeenCalledTimes(1);
    expect(ajeno.accountId).toBeNull();
    expect(sinUnidad.accountId).toBeNull();
  });

  it('pagina con límite y cursor: repetir hasta pendientes 0 procesa a cada uno exactamente una vez', async () => {
    const ts = residentes(5);
    const m = montar({ terceros: ts, unidades: conUnidades(ts) });

    const primera = await m.servicio.aprovisionar({ limite: 2 }, USER);
    expect(primera).toMatchObject({ procesados: 2, pendientes: 3 });
    expect(primera.siguienteDesde).not.toBeNull();

    let cursor = primera.siguienteDesde;
    let creados = primera.creados;
    let vueltas = 0;
    while (cursor && vueltas++ < 10) {
      const r = await m.servicio.aprovisionar(
        { limite: 2, desde: cursor },
        USER,
      );
      creados += r.creados;
      cursor = r.siguienteDesde;
    }

    expect(creados).toBe(5);
    expect(m.firebase.crear).toHaveBeenCalledTimes(5);
    expect(m.identidades.size).toBe(5);
  });

  it('el tamaño de página nunca pasa de 25', async () => {
    const ts = residentes(30);
    const m = montar({ terceros: ts, unidades: conUnidades(ts) });

    const r = await m.servicio.aprovisionar({ limite: 500 }, USER);

    expect(r.procesados).toBe(25);
    expect(r.pendientes).toBe(5);
  });

  it('nunca vincula una cuenta existente: la reporta como omitida con su motivo', async () => {
    const c = cuenta({ email: 'r0@correo.co' });
    const ts = residentes(2);
    const m = montar({ terceros: ts, unidades: conUnidades(ts), cuentas: [c] });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r.creados).toBe(1);
    expect(r.omitidos).toHaveLength(1);
    expect(r.omitidos[0].terceroId).toBe(ts[0]._id.toString());
    expect(r.omitidos[0].motivo).toMatch(/cuenta/i);
    expect(ts[0].accountId).toBeNull();
    expect(m.firebase.crear).toHaveBeenCalledTimes(1);
  });

  it('el aprovisionamiento masivo nunca vincula una cuenta que ya existe, sea de personal o de administrador de plataforma', async () => {
    const staff = cuenta({ email: 'r0@correo.co' });
    const root = cuenta({
      email: 'r1@correo.co',
      esAdministradorPlataforma: true,
    });
    const ts = residentes(2);
    const m = montar({
      terceros: ts,
      unidades: conUnidades(ts),
      cuentas: [staff, root],
      personal: [staff._id],
    });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r.omitidos).toHaveLength(2);
    expect(ts.every((t) => t.accountId === null)).toBe(true);
  });

  it('un conflicto de Firebase es un error de ESA fila y no frena a las demás', async () => {
    const ts = residentes(3);
    const m = montar({
      terceros: ts,
      unidades: conUnidades(ts),
      firebaseConoce: ['r1@correo.co'],
    });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r.creados).toBe(2);
    expect(r.errores).toHaveLength(1);
    expect(r.errores[0].terceroId).toBe(ts[1]._id.toString());
    expect(r.errores[0].mensaje).toContain('Firebase');
    expect(ts[1].accountId).toBeNull();
  });

  it('es idempotente: repetir la corrida no crea una segunda identidad', async () => {
    const ts = residentes(4);
    const m = montar({ terceros: ts, unidades: conUnidades(ts) });

    await m.servicio.aprovisionar({}, USER);
    const segunda = await m.servicio.aprovisionar({}, USER);

    expect(segunda).toMatchObject({ procesados: 0, creados: 0, pendientes: 0 });
    expect(m.firebase.crear).toHaveBeenCalledTimes(4);
    expect(m.identidades.size).toBe(4);
  });

  it('tras un corte (identidad creada, cuenta local no guardada) el reintento no duplica la identidad', async () => {
    const ts = residentes(2);
    const m = montar({
      terceros: ts,
      unidades: conUnidades(ts),
      falloGuardarCuenta: ['r0@correo.co'],
    });

    const primera = await m.servicio.aprovisionar({}, USER);
    expect(primera.errores).toHaveLength(1);
    expect(m.identidades.size).toBe(2);

    const segunda = await m.servicio.aprovisionar({}, USER);

    // Firebase refuses the second creation: reported per row, no new identity.
    expect(segunda.errores).toHaveLength(1);
    expect(segunda.errores[0].mensaje).toContain('Firebase');
    expect(m.identidades.size).toBe(2);
    expect(ts[0].accountId).toBeNull();
  });

  it('dos terceros con el mismo correo: crea uno y omite el otro (una cuenta, un tercero por copropiedad)', async () => {
    const a = tercero({ nombre: 'Uno', emails: ['mismo@correo.co'] });
    const b = tercero({ nombre: 'Dos', emails: ['mismo@correo.co'] });
    const m = montar({ terceros: [a, b], unidades: conUnidades([a, b]) });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r.creados).toBe(1);
    expect(r.omitidos).toHaveLength(1);
    expect(m.firebase.crear).toHaveBeenCalledTimes(1);
  });

  it('nunca tiene más de 5 llamadas a Firebase en vuelo', async () => {
    const ts = residentes(20);
    const m = montar({ terceros: ts, unidades: conUnidades(ts), retraso: 5 });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r.creados).toBe(20);
    expect(m.maxActivos()).toBeLessThanOrEqual(5);
    expect(m.maxActivos()).toBeGreaterThan(1);
  });

  it('sin correo configurado crea las cuentas y lo declara; no se envía ni se emite ningún enlace', async () => {
    const ts = residentes(2);
    const m = montar({
      terceros: ts,
      unidades: conUnidades(ts),
      correoConfigurado: false,
    });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r.creados).toBe(2);
    expect(r.invitacionesEnviadas).toBe(0);
    expect(r.correoConfigurado).toBe(false);
    expect(m.enlaces.construir).not.toHaveBeenCalled();
  });

  it('ninguna contraseña aparece en los correos ni en la respuesta del lote', async () => {
    const ts = residentes(3);
    const m = montar({ terceros: ts, unidades: conUnidades(ts) });

    const r = await m.servicio.aprovisionar({}, USER);

    expect(m.passwords).toHaveLength(3);
    const salida =
      JSON.stringify(r) + m.enviados.map((e) => e.html + e.asunto).join('');
    for (const p of m.passwords) expect(salida).not.toContain(p);
  });

  it('una falla inesperada de una fila no filtra su texto interno', async () => {
    const ts = residentes(1);
    const m = montar({ terceros: ts, unidades: conUnidades(ts) });
    m.firebase.crear.mockRejectedValueOnce(
      new Error('secreto interno: mongodb://u:p@host'),
    );

    const r = await m.servicio.aprovisionar({}, USER);

    expect(r.errores).toHaveLength(1);
    expect(r.errores[0].mensaje).not.toContain('mongodb');
  });

  it('todas las consultas de terceros llevan la copropiedad activa', async () => {
    const ts = residentes(1);
    const m = montar({ terceros: ts, unidades: conUnidades(ts) });

    await m.servicio.aprovisionar({}, USER);

    for (const [filtro] of m.tercerosModel.find.mock.calls) {
      expect(String(filtro.copropiedadId)).toBe(COP.toString());
    }
    for (const [filtro] of m.tercerosModel.updateOne.mock.calls) {
      expect(String(filtro.copropiedadId)).toBe(COP.toString());
    }
  });
});

describe('AccesoResidentesService.listar', () => {
  it('lista a quienes tienen unidad con su estado, unidades y rol, sin exponer la cuenta', async () => {
    const c = cuenta();
    const conCuenta = tercero({
      nombre: 'Con Cuenta',
      emails: ['a@x.co'],
      accountId: c._id,
    });
    const sinCuenta = tercero({ nombre: 'Sin Cuenta', emails: ['b@x.co'] });
    const sinUnidad = tercero({ nombre: 'Sin Unidad' });
    const m = montar({
      terceros: [conCuenta, sinCuenta, sinUnidad],
      cuentas: [c],
      unidades: [
        { codigo: 'A-1', titular: conCuenta, arrendatario: sinCuenta },
        { codigo: 'A-2', titular: conCuenta },
      ],
    });

    const r = await m.servicio.listar({});

    expect(r.total).toBe(2);
    const fila = r.items.find((i) => i.nombre === 'Con Cuenta')!;
    expect(fila.estadoAcceso).toBe('conCuenta');
    expect(fila.unidades.map((u) => `${u.codigo}:${u.rol}`)).toEqual([
      'A-1:propietario',
      'A-2:propietario',
    ]);
    expect(r.items.find((i) => i.nombre === 'Sin Cuenta')).toMatchObject({
      estadoAcceso: 'sinCuenta',
      aprovisionable: true,
      unidades: [{ codigo: 'A-1', rol: 'arrendatario' }],
    });
    expect(JSON.stringify(r)).not.toContain(c._id.toString());
  });

  it('marca la cuenta inactiva y filtra por estado de acceso', async () => {
    const c = cuenta({ estado: 'inactive' });
    const t = tercero({ nombre: 'Inactiva', accountId: c._id });
    const s = tercero({ nombre: 'Libre', emails: ['l@x.co'] });
    const m = montar({
      terceros: [t, s],
      cuentas: [c],
      unidades: [
        { codigo: 'B-1', titular: t },
        { codigo: 'B-2', titular: s },
      ],
    });

    const todos = await m.servicio.listar({});
    expect(todos.items.find((i) => i.nombre === 'Inactiva')!.estadoAcceso).toBe(
      'cuentaInactiva',
    );

    const soloSin = await m.servicio.listar({ estadoAcceso: 'sinCuenta' });
    expect(soloSin.items.map((i) => i.nombre)).toEqual(['Libre']);
    const soloCon = await m.servicio.listar({ estadoAcceso: 'conCuenta' });
    expect(soloCon.items.map((i) => i.nombre)).toEqual(['Inactiva']);
  });

  it('busca por nombre, correo o código de unidad, siempre dentro de la copropiedad', async () => {
    const t = tercero({ nombre: 'Marta Ríos', emails: ['marta@x.co'] });
    const ajeno = tercero({ nombre: 'Marta Ajena', copropiedadId: OTRA_COP });
    const m = montar({
      terceros: [t, ajeno],
      unidades: [
        { codigo: 'TORRE-9', titular: t },
        { codigo: 'TORRE-10', titular: ajeno },
      ],
    });

    expect((await m.servicio.listar({ buscar: 'marta' })).items).toHaveLength(
      1,
    );
    expect((await m.servicio.listar({ buscar: 'torre-9' })).items).toHaveLength(
      1,
    );
    expect((await m.servicio.listar({ buscar: 'zzz' })).items).toHaveLength(0);
    const filtro = m.tercerosModel.find.mock.calls[0][0];
    expect(String(filtro.copropiedadId)).toBe(COP.toString());
  });
});

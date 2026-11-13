import { Types } from 'mongoose';
import {
  DocumentosActorService,
  puedeGestionar,
} from './documentos-actor.service';

const COPROPIEDAD = new Types.ObjectId();
const CUENTA = new Types.ObjectId();
const ROL_A = new Types.ObjectId();
const ROL_B = new Types.ObjectId();

const consulta = (valor: unknown) => {
  const q: Record<string, jest.Mock> = {};
  q.exec = jest.fn().mockResolvedValue(valor);
  q.select = jest.fn().mockReturnValue(q);
  q.lean = jest.fn().mockReturnValue(q);
  return q;
};

function montar(
  asignaciones: unknown[] = [],
  cuentas: unknown[] = [],
  permisos: string[] = [],
) {
  const modeloAsignaciones = {
    find: jest.fn().mockReturnValue(consulta(asignaciones)),
  };
  const modeloCuentas = { find: jest.fn().mockReturnValue(consulta(cuentas)) };
  const acceso = {
    accesoA: jest.fn().mockResolvedValue({ permissions: permisos }),
  };
  const tenant = {
    resolveCoPropertyId: jest.fn().mockReturnValue(COPROPIEDAD),
  };
  const servicio = new DocumentosActorService(
    modeloAsignaciones as never,
    modeloCuentas as never,
    acceso as never,
    tenant as never,
  );
  return { servicio, modeloAsignaciones, modeloCuentas, acceso };
}

describe('puedeGestionar', () => {
  it('es true para el administrador de plataforma o con la llave gestionar', () => {
    expect(puedeGestionar({ isPlatformAdmin: true })).toBe(true);
    expect(
      puedeGestionar({ permissions: ['documentos-administracion.gestionar'] }),
    ).toBe(true);
  });

  it('es false con solo ver o subir, o sin permisos', () => {
    expect(
      puedeGestionar({
        permissions: [
          'documentos-administracion.ver',
          'documentos-administracion.subir',
        ],
      }),
    ).toBe(false);
    expect(puedeGestionar({})).toBe(false);
  });
});

describe('DocumentosActorService.deSolicitud', () => {
  it('quien gestiona no necesita consultar roles', async () => {
    const { servicio, modeloAsignaciones } = montar();
    const actor = await servicio.deSolicitud({
      uid: 'u',
      email: 'e',
      accountId: CUENTA.toString(),
      permissions: ['documentos-administracion.gestionar'],
    });
    expect(actor.gestiona).toBe(true);
    expect(modeloAsignaciones.find).not.toHaveBeenCalled();
  });

  it('lee los roles de la asignación directa a la copropiedad activa, activa', async () => {
    const { servicio, modeloAsignaciones } = montar([
      { accountId: CUENTA, roleIds: [ROL_A, ROL_B] },
    ]);

    const actor = await servicio.deSolicitud({
      uid: 'u',
      email: 'e',
      accountId: CUENTA.toString(),
    });

    expect(modeloAsignaciones.find).toHaveBeenCalledWith({
      accountId: { $in: [CUENTA] },
      copropiedadId: COPROPIEDAD,
      alcance: 'copropiedad',
      estado: 'active',
    });
    expect(actor.gestiona).toBe(false);
    expect([...actor.roleIds].sort()).toEqual(
      [ROL_A.toString(), ROL_B.toString()].sort(),
    );
  });

  it('sin cuenta identificable no tiene roles ni consulta nada', async () => {
    const { servicio, modeloAsignaciones } = montar();
    const actor = await servicio.deSolicitud({ uid: 'u', email: 'e' });
    expect(actor).toEqual({ roleIds: new Set(), gestiona: false });
    expect(modeloAsignaciones.find).not.toHaveBeenCalled();
  });
});

describe('DocumentosActorService.deCuentas', () => {
  it('resuelve roles y gestión por cuenta, incluido el administrador de plataforma', async () => {
    const OTRA = new Types.ObjectId();
    const { servicio, acceso } = montar(
      [{ accountId: CUENTA, roleIds: [ROL_A] }],
      [{ _id: OTRA, esAdministradorPlataforma: true }],
    );
    acceso.accesoA.mockResolvedValue({ permissions: [] });

    const mapa = await servicio.deCuentas(
      [CUENTA.toString(), OTRA.toString()],
      COPROPIEDAD,
    );

    expect(mapa.get(CUENTA.toString())).toEqual({
      roleIds: new Set([ROL_A.toString()]),
      gestiona: false,
    });
    expect(mapa.get(OTRA.toString())?.gestiona).toBe(true);
  });

  it('marca gestiona cuando los permisos efectivos incluyen la llave', async () => {
    const { servicio } = montar(
      [],
      [],
      ['documentos-administracion.gestionar'],
    );
    const mapa = await servicio.deCuentas([CUENTA.toString()], COPROPIEDAD);
    expect(mapa.get(CUENTA.toString())?.gestiona).toBe(true);
  });

  it('pasa a AccesoService la cuenta que ya leyó, sin otra lectura por cuenta', async () => {
    const { servicio, acceso, modeloCuentas } = montar(
      [],
      [
        {
          _id: CUENTA,
          email: 'p@x.co',
          estado: 'active',
          correoProbadoClave: null,
          esAdministradorPlataforma: false,
        },
      ],
    );

    await servicio.deCuentas([CUENTA.toString()], COPROPIEDAD);

    expect(acceso.accesoA).toHaveBeenCalledWith(
      CUENTA.toString(),
      COPROPIEDAD.toString(),
      false,
      { email: 'p@x.co', estado: 'active', correoProbadoClave: null },
    );
    expect(modeloCuentas.find).toHaveBeenCalledTimes(1);
  });

  it('ignora ids mal formados y no consulta con lista vacía', async () => {
    const { servicio, modeloAsignaciones } = montar();
    const mapa = await servicio.deCuentas(['no-es-id'], COPROPIEDAD);
    expect(mapa.size).toBe(0);
    expect(modeloAsignaciones.find).not.toHaveBeenCalled();
  });
});

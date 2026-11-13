// src/modules/acceso-residentes/testing/montar-residentes-correos.ts
//
// Hand-rolled collaborators for the ResidentesCorreosService specs (list,
// revoke/re-allow, resend). Lives in `testing/` so the SWC build leaves it out
// of the image.
import { Types } from 'mongoose';
import { coincide } from '../../envio-facturas/testing/coleccion-memoria';
import { SesionFalsa } from '../../ingreso-portal/testing/montar-servicio';
import { ResidentesCorreosService } from '../residentes-correos.service';

export const COP = new Types.ObjectId();
export const OTRA_COP = new Types.ObjectId();

export interface TerceroFake {
  _id: Types.ObjectId;
  copropiedadId: Types.ObjectId;
  nombre: string;
  emails: string[];
  accountId: Types.ObjectId | null;
  estado: 'active' | 'inactive';
}

export interface InmuebleFake {
  _id: Types.ObjectId;
  copropiedadId: Types.ObjectId;
  codigo: string;
  estado: 'active' | 'inactive';
  titularId: Types.ObjectId | null;
  arrendatarioId: Types.ObjectId | null;
}

export interface CuentaFake {
  _id: Types.ObjectId;
  email: string;
  correoProbadoClave: string | null;
  ultimoIngresoPortalEn: Date | null;
}

export const tercero = (over: Partial<TerceroFake> = {}): TerceroFake => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  nombre: 'Ana Pérez',
  emails: ['ana@correo.co'],
  accountId: null,
  estado: 'active',
  ...over,
});

export const inmueble = (
  titular: TerceroFake | null,
  over: Partial<InmuebleFake> = {},
): InmuebleFake => ({
  _id: new Types.ObjectId(),
  copropiedadId: COP,
  codigo: '101',
  estado: 'active',
  titularId: titular?._id ?? null,
  arrendatarioId: null,
  ...over,
});

export const cuenta = (over: Partial<CuentaFake> = {}): CuentaFake => ({
  _id: new Types.ObjectId(),
  email: 'ana@correo.co',
  correoProbadoClave: null,
  ultimoIngresoPortalEn: null,
  ...over,
});

export const USUARIO = {
  uid: 'uid-admin',
  email: 'admin@edificio.co',
  accountId: new Types.ObjectId().toString(),
  nombre: 'Admin Edificio',
};

const mismo = (a: unknown, b: unknown): boolean => String(a) === String(b);

/** A chainable query that answers what the callback computes at `exec` time. */
const consulta = <T>(resultado: () => T) => {
  const q = {
    select: () => q,
    sort: () => q,
    lean: () => q,
    exec: () => Promise.resolve(resultado()),
  };
  return q;
};

export interface Opciones {
  terceros?: TerceroFake[];
  inmuebles?: InmuebleFake[];
  cuentas?: CuentaFake[];
  /** `clave`s revoked in the active coproperty (list specs, stand-in residency). */
  revocadas?: string[];
  /** Normalized address -> reason. */
  genericos?: [string, 'correo-compartido'][];
  /** Existing revocation rows (the store the revoke and re-allow write to). */
  revocaciones?: Record<string, unknown>[];
  /** Writing the audit entry fails. */
  auditoriaFalla?: boolean;
}

export function montar(opciones: Opciones = {}) {
  const terceros = opciones.terceros ?? [];
  const inmuebles = opciones.inmuebles ?? [];
  const cuentas = opciones.cuentas ?? [];
  const filtrosTerceros: Record<string, unknown>[] = [];
  const filtrosInmuebles: Record<string, unknown>[] = [];
  const filtrosCuentas: Record<string, unknown>[] = [];

  const modeloInmuebles = {
    find: jest.fn((filtro: Record<string, unknown>) => {
      filtrosInmuebles.push(filtro);
      return consulta(() =>
        inmuebles
          .filter(
            (u) =>
              mismo(u.copropiedadId, filtro.copropiedadId) &&
              u.estado === filtro.estado &&
              (u.titularId !== null || u.arrendatarioId !== null),
          )
          .sort((a, b) => a.codigo.localeCompare(b.codigo)),
      );
    }),
  };
  const modeloTerceros = {
    find: jest.fn((filtro: Record<string, unknown>) => {
      filtrosTerceros.push(filtro);
      const ids = (filtro._id as { $in: Types.ObjectId[] }).$in;
      return consulta(() =>
        terceros
          .filter(
            (t) =>
              mismo(t.copropiedadId, filtro.copropiedadId) &&
              t.estado === filtro.estado &&
              ids.some((id) => mismo(id, t._id)),
          )
          .sort((a, b) => a.nombre.localeCompare(b.nombre)),
      );
    }),
    findOne: jest.fn((filtro: Record<string, unknown>) => {
      filtrosTerceros.push(filtro);
      return consulta(
        () =>
          terceros.find(
            (t) =>
              mismo(t._id, filtro._id) &&
              mismo(t.copropiedadId, filtro.copropiedadId) &&
              t.estado === filtro.estado,
          ) ?? null,
      );
    }),
    // Revoking or resending must never touch a party: these fail the spec if used.
    updateOne: jest.fn(),
    updateMany: jest.fn(),
  };
  const modeloCuentas = {
    find: jest.fn((filtro: Record<string, unknown>) => {
      filtrosCuentas.push(filtro);
      const ramas = filtro.$or as Record<string, { $in: unknown[] }>[];
      return consulta(() =>
        cuentas.filter((c) =>
          ramas.some((r) =>
            r.email
              ? r.email.$in.includes(c.email)
              : r._id.$in.some((id) => mismo(id, c._id)),
          ),
        ),
      );
    }),
    findOne: jest.fn((filtro: Record<string, unknown>) => {
      filtrosCuentas.push(filtro);
      return consulta(
        () => cuentas.find((c) => mismo(c._id, filtro._id)) ?? null,
      );
    }),
    updateOne: jest.fn(),
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
  };

  // The revocation store: a partial unique index on (coproperty, clave) while
  // `activa`, and an undo log on the session, as the real transaction has.
  const filasRevocacion: Record<string, unknown>[] = [
    ...(opciones.revocaciones ?? []),
  ];
  const modeloRevocaciones = {
    filas: filasRevocacion,
    create: jest.fn(
      (
        docs: Record<string, unknown>[],
        opts?: { session?: SesionFalsa },
      ): Promise<Record<string, unknown>[]> => {
        const doc = docs[0];
        const choca = filasRevocacion.some(
          (r) =>
            r.activa === true &&
            doc.activa === true &&
            mismo(r.copropiedadId, doc.copropiedadId) &&
            r.clave === doc.clave,
        );
        if (choca) {
          return Promise.reject(
            Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
          );
        }
        const nueva = { _id: new Types.ObjectId(), ...doc };
        filasRevocacion.push(nueva);
        opts?.session?.deshacer.push(() => {
          filasRevocacion.splice(filasRevocacion.indexOf(nueva), 1);
        });
        return Promise.resolve([{ ...nueva }]);
      },
    ),
    findOneAndUpdate: jest.fn(
      (
        filtro: Record<string, unknown>,
        cambio: { $set: Record<string, unknown> },
        opts?: { session?: SesionFalsa },
      ) =>
        consulta(() => {
          const fila = filasRevocacion.find((r) => coincide(r, filtro));
          if (!fila) return null;
          const antes = { ...fila };
          Object.assign(fila, cambio.$set);
          opts?.session?.deshacer.push(() => Object.assign(fila, antes));
          return { ...fila };
        }),
    ),
    find: jest.fn((filtro: Record<string, unknown>) =>
      consulta(() =>
        filasRevocacion
          .filter((r) => coincide(r, filtro))
          .map((r) => ({ ...r })),
      ),
    ),
  };

  const tenant = { resolveCoPropertyId: jest.fn(() => COP) };
  const residencia = {
    clavesRevocadas: jest.fn(
      (claves: readonly string[], copropiedadId: string) => {
        void copropiedadId;
        return Promise.resolve(
          new Set(claves.filter((c) => (opciones.revocadas ?? []).includes(c))),
        );
      },
    ),
    motivosCorreoGenerico: jest.fn(() =>
      Promise.resolve(new Map(opciones.genericos ?? [])),
    ),
  };

  const entradasAuditoria: Record<string, unknown>[] = [];
  const auditoria = {
    registrar: jest.fn(
      (entrada: Record<string, unknown>, session?: SesionFalsa) => {
        if (opciones.auditoriaFalla) {
          return Promise.reject(new Error('audit down'));
        }
        entradasAuditoria.push(entrada);
        session?.deshacer.push(() => {
          entradasAuditoria.splice(entradasAuditoria.indexOf(entrada), 1);
        });
        return Promise.resolve();
      },
    ),
  };
  const sesiones: SesionFalsa[] = [];
  const connection = {
    startSession: jest.fn(() => {
      const sesion = new SesionFalsa();
      sesiones.push(sesion);
      return Promise.resolve(sesion);
    }),
  };

  const servicio = new ResidentesCorreosService(
    modeloInmuebles as never,
    modeloTerceros as never,
    modeloCuentas as never,
    tenant as never,
    residencia as never,
    modeloRevocaciones as never,
    auditoria as never,
    connection as never,
  );
  return {
    servicio,
    modeloInmuebles,
    modeloTerceros,
    modeloCuentas,
    modeloRevocaciones,
    residencia,
    tenant,
    auditoria,
    entradasAuditoria,
    connection,
    sesiones,
    filtrosTerceros,
    filtrosInmuebles,
    filtrosCuentas,
  };
}

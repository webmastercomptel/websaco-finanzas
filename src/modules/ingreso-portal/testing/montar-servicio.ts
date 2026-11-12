// src/modules/ingreso-portal/testing/montar-servicio.ts
//
// Hand-rolled collaborators for the IngresoPortalService specs (request side
// and redeem side share them). Lives in `testing/` so the SWC build leaves it
// out of the image.
import { Types } from 'mongoose';
import { claveCorreo } from '../../../common/utils/email.utils';
import { ColeccionMemoria } from '../../envio-facturas/testing/coleccion-memoria';
import { IngresoPortalService } from '../ingreso-portal.service';

export const CORREO = 'ana@example.com';
export const CLAVE = claveCorreo(CORREO);
export const TOKEN = 'ab'.repeat(32);
export const COPRO_A = new Types.ObjectId().toString();
export const COPRO_B = new Types.ObjectId().toString();
export const CUENTA_ID = new Types.ObjectId();

export interface CuentaDePrueba {
  _id: Types.ObjectId;
  email: string;
  firebaseUid: string;
  nombreCompleto: string;
  estado: 'active' | 'inactive';
  esAdministradorPlataforma: boolean;
  correoProbadoClave: string | null;
  correoProbadoEn: Date | null;
  ultimoIngresoPortalEn: Date | null;
}

export const cuentaDePrueba = (
  over: Partial<CuentaDePrueba> = {},
): CuentaDePrueba => ({
  _id: CUENTA_ID,
  email: CORREO,
  firebaseUid: 'uid-1',
  nombreCompleto: 'Ana',
  estado: 'active',
  esAdministradorPlataforma: false,
  correoProbadoClave: null,
  correoProbadoEn: null,
  ultimoIngresoPortalEn: null,
  ...over,
});

export interface Opciones {
  /** What `copropiedadesPorCorreo` answers: coproperty id -> party ids. */
  copropiedades?: Map<string, string[]>;
  /** Coproperties with an active revocation. */
  revocadas?: string[];
  /** The Account of the address, if any. */
  cuenta?: Partial<CuentaDePrueba> | null;
  /** `permitir` answers in call order; default true. */
  permisos?: boolean[] | ((clave: string) => boolean);
  configurado?: boolean;
  enviado?: boolean;
  frontendUrl?: string | undefined;
  crearFalla?: boolean;
  /** What the sign-in link store answers on consume; null = no such link. */
  fila?: {
    clave: string;
    correo: string;
    origen: 'autoservicio' | 'personal';
    solicitadoPor: Types.ObjectId | null;
  } | null;
  /** The coproperties the Account reaches, with their effective keys. */
  accesos?: { copropiedadId: string; permissions: string[] }[];
  /** An active assignment that is not `personal`. */
  noPersonal?: boolean;
  /** What minting the custom token does. */
  tokenFalla?: boolean;
  /** A real in-memory store for the Account (filters and updates evaluated). */
  cuentasEnMemoria?: ColeccionMemoria;
}

export function montar(over: Opciones = {}) {
  const eventos: string[] = [];

  const copropiedades =
    over.copropiedades ??
    new Map([[COPRO_A, [new Types.ObjectId().toString()]]]);
  const residencia = {
    copropiedadesPorCorreo: jest.fn(() => {
      eventos.push('elegibilidad');
      return Promise.resolve(copropiedades);
    }),
    revocacionesActivas: jest
      .fn()
      .mockResolvedValue(new Set(over.revocadas ?? [])),
  };
  const enlaces = {
    crear: over.crearFalla
      ? jest.fn().mockRejectedValue(new Error('E11000 dup key: { tokenHash }'))
      : jest.fn().mockResolvedValue({ token: TOKEN, expiraEn: new Date() }),
    consumir: jest.fn(() => {
      eventos.push('consumir');
      return Promise.resolve(
        over.fila === undefined
          ? {
              clave: CLAVE,
              correo: CORREO,
              origen: 'autoservicio' as const,
              solicitadoPor: null,
            }
          : over.fila,
      );
    }),
  };
  const correo = {
    estaConfigurado: jest.fn(() => over.configurado ?? true),
    enviar: jest.fn().mockResolvedValue(over.enviado ?? true),
  };
  const config = {
    get: jest.fn((clave: string) =>
      clave === 'app.frontendUrl'
        ? 'frontendUrl' in over
          ? over.frontendUrl
          : 'https://app.ejemplo.com'
        : undefined,
    ),
  };
  const llamadasPermitir: string[] = [];
  const respuestas = Array.isArray(over.permisos) ? [...over.permisos] : [];
  const limite = {
    permitir: jest.fn((clave: string) => {
      llamadasPermitir.push(clave);
      if (typeof over.permisos === 'function') {
        return Promise.resolve(over.permisos(clave));
      }
      return Promise.resolve(
        respuestas.length > 0 ? respuestas.shift()! : true,
      );
    }),
  };

  const cuenta = over.cuenta === undefined ? null : over.cuenta;
  const actualizaciones: { filtro: unknown; cambio: unknown }[] = [];
  const cuentasSimuladas = {
    findOne: jest.fn(() => {
      const cadena = {
        select: () => cadena,
        lean: () => cadena,
        exec: () =>
          Promise.resolve(cuenta === null ? null : cuentaDePrueba(cuenta)),
      };
      return cadena;
    }),
    updateOne: jest.fn((filtro: unknown, cambio: unknown) => {
      actualizaciones.push({ filtro, cambio });
      eventos.push('prueba');
      return { exec: () => Promise.resolve({ modifiedCount: 1 }) };
    }),
  };
  // Typed as mocks so specs can assert on them (the in-memory store is cast).
  const cuentas = (over.cuentasEnMemoria ?? cuentasSimuladas) as unknown as {
    findOne: jest.Mock;
    updateOne: jest.Mock;
  };
  const acceso = {
    copropiedadesDe: jest.fn(() => {
      eventos.push('accesos');
      return Promise.resolve(over.accesos ?? []);
    }),
  };
  const asignaciones = {
    exists: jest.fn(() => ({
      exec: () =>
        Promise.resolve(over.noPersonal ? { _id: new Types.ObjectId() } : null),
    })),
  };
  const auth = {
    createCustomToken: jest.fn((uid: string) => {
      eventos.push('token');
      return over.tokenFalla
        ? Promise.reject(new Error('firebase down'))
        : Promise.resolve(`custom-token-de-${uid}`);
    }),
  };

  const servicio = new IngresoPortalService(
    residencia as never,
    enlaces as never,
    correo as never,
    config as never,
    limite as never,
    cuentas as never,
    asignaciones as never,
    acceso as never,
    auth as never,
  );
  return {
    servicio,
    residencia,
    enlaces,
    correo,
    config,
    limite,
    cuentas,
    asignaciones,
    acceso,
    auth,
    llamadasPermitir,
    actualizaciones,
    eventos,
  };
}

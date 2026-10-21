// src/modules/integraciones-websaco3/propietarios.mapper.ts
import type { Types } from 'mongoose';
import type {
  PropietariosWebsaco3,
  TitularWebsaco3,
  UnidadPropietarioWebsaco3,
} from '../../contracts';
import { esEmailValido } from '../../common/utils/email.utils';

/** The only `Inmueble` fields the snapshot reads (`select` in the service). */
export interface InmuebleParaPropietarios {
  codigo: string;
  titularId: Types.ObjectId | null;
  tipoTitular: 'propietario' | 'arrendatario';
}

/** The only `Tercero` fields the snapshot reads. */
export interface TerceroParaPropietarios {
  _id: Types.ObjectId;
  nombre: string;
  emails: string[];
  telefono: string | null;
  estado: 'active' | 'inactive';
}

/**
 * Upper bound of `titular.emails`. The consumer applies its own, smaller cap
 * on what it stores; this one only keeps the snapshot payload bounded when a
 * party has an absurd number of addresses.
 */
export const MAX_EMAILS_TITULAR_WEBSACO3 = 50;

/**
 * Longest address the consumer accepts per item (RFC 5321 path limit). The
 * consumer validates every item of `emails` and rejects the WHOLE snapshot on
 * one violation, so an over-long legacy address must be dropped here instead
 * of failing the sync of the entire coproperty.
 */
export const MAX_LARGO_EMAIL_WEBSACO3 = 254;

/**
 * Valid addresses of a party: trimmed, deduped case-insensitively (the first
 * spelling is kept), original order preserved. Validity goes through the same
 * `esEmailValido` the bulk import uses so both agree on what is an address.
 */
const emailsValidos = (emails: string[] | undefined): string[] => {
  const vistos = new Set<string>();
  const validos: string[] = [];
  for (const email of emails ?? []) {
    const limpio = typeof email === 'string' ? email.trim() : '';
    if (limpio.length > MAX_LARGO_EMAIL_WEBSACO3) continue;
    if (!esEmailValido(limpio)) continue;
    const clave = limpio.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    validos.push(limpio);
  }
  return validos;
};

const aTitular = (tercero: TerceroParaPropietarios): TitularWebsaco3 => {
  const emails = emailsValidos(tercero.emails).slice(
    0,
    MAX_EMAILS_TITULAR_WEBSACO3,
  );
  return {
    nombre: tercero.nombre,
    email: emails[0] ?? null,
    emails,
    telefono: tercero.telefono?.trim() || null,
  };
};

/**
 * Pure builder of the holders snapshot. `terceros` is whatever the service
 * managed to read for THIS coproperty; only active ones are honored here too,
 * so a party that is unresolved, foreign or retired yields `titular: null`
 * (an inactive party is not a current holder). Every unit is kept regardless
 * of its own `estado`, in the order received.
 */
export function mapearPropietarios(
  copropiedad: { nombre: string },
  inmuebles: InmuebleParaPropietarios[],
  terceros: TerceroParaPropietarios[],
): PropietariosWebsaco3 {
  const porId = new Map<string, TerceroParaPropietarios>();
  for (const tercero of terceros) {
    if (tercero.estado === 'active') porId.set(String(tercero._id), tercero);
  }

  const unidades: UnidadPropietarioWebsaco3[] = inmuebles.map((inmueble) => {
    const tercero = inmueble.titularId
      ? porId.get(String(inmueble.titularId))
      : undefined;
    return {
      codigo: inmueble.codigo,
      tipo: inmueble.tipoTitular,
      titular: tercero ? aTitular(tercero) : null,
    };
  });

  return { copropiedad: { nombre: copropiedad.nombre }, unidades };
}

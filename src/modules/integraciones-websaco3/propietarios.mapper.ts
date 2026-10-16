// src/modules/integraciones-websaco3/propietarios.mapper.ts
import type { Types } from 'mongoose';
import type {
  PropietariosWebsaco3,
  TitularWebsaco3,
  UnidadPropietarioWebsaco3,
} from '../../contracts';

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

const primerEmail = (emails: string[] | undefined): string | null => {
  for (const email of emails ?? []) {
    const limpio = typeof email === 'string' ? email.trim() : '';
    if (limpio.length > 0) return limpio;
  }
  return null;
};

const aTitular = (tercero: TerceroParaPropietarios): TitularWebsaco3 => ({
  nombre: tercero.nombre,
  email: primerEmail(tercero.emails),
  telefono: tercero.telefono?.trim() || null,
});

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

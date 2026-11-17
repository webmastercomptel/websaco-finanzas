// src/modules/organos/organos.reglas.ts
import type { Types } from 'mongoose';
import { correosValidos } from '../../common/directorio/destinos-correo';
import type { UnidadDeIntegrante } from '../../contracts';

/**
 * The units each party holds, by `terceroId.toString()`. A party on both sides
 * of one unit gets both rows; each list is sorted by unit code.
 */
export function unidadesPorTercero(
  inmuebles: {
    codigo: string;
    titularId?: Types.ObjectId | null;
    arrendatarioId?: Types.ObjectId | null;
  }[],
): Map<string, UnidadDeIntegrante[]> {
  const mapa = new Map<string, UnidadDeIntegrante[]>();
  const agregar = (
    id: Types.ObjectId | null | undefined,
    codigo: string,
    rol: UnidadDeIntegrante['rol'],
  ) => {
    if (!id) return;
    const clave = id.toString();
    const lista = mapa.get(clave) ?? [];
    lista.push({ codigo, rol });
    mapa.set(clave, lista);
  };
  for (const i of inmuebles) {
    agregar(i.titularId, i.codigo, 'propietario');
    agregar(i.arrendatarioId, i.codigo, 'arrendatario');
  }
  for (const lista of mapa.values()) {
    lista.sort((a, b) => a.codigo.localeCompare(b.codigo));
  }
  return mapa;
}

/** Every valid address of the parties, once per normalized key, stored spelling. */
export function correosDeIntegrantes(
  partes: { emails?: string[] | null }[],
): string[] {
  const vistos = new Set<string>();
  const salida: string[] = [];
  for (const parte of partes) {
    for (const { email, clave } of correosValidos(parte.emails)) {
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      salida.push(email);
    }
  }
  return salida;
}

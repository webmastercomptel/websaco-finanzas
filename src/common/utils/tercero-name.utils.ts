// src/common/utils/tercero-name.utils.ts

/**
 * Resolves a Tercero's display `name` from whichever parts are present: the
 * split fields win over an explicit `nombre` fallback when they can build a
 * real name — `nombre` is for callers with no parts to offer (the Excel
 * bulk import), never a competing source once nom1/ape1 or razonSocial
 * exist. Null means neither path produced anything — the caller must reject
 * or fall back on its own terms.
 *
 * Shared by `TercerosService` (the Terceros screen) and `InmueblesService`
 * (the Inmuebles bulk import, which creates a Tercero inline per row) so
 * the concatenation rule lives in exactly one place.
 */
export function resolverNombreTercero(datos: {
  tipoPersona: 'natural' | 'juridica';
  nombre?: string;
  nom1?: string;
  nom2?: string;
  ape1?: string;
  ape2?: string;
  razonSocial?: string;
}): string | null {
  if (datos.tipoPersona === 'juridica') {
    const razonSocial = datos.razonSocial?.trim();
    if (razonSocial) return razonSocial;
    return datos.nombre?.trim() || null;
  }

  const nom1 = datos.nom1?.trim();
  const ape1 = datos.ape1?.trim();
  if (nom1 && ape1) {
    return [nom1, datos.nom2?.trim(), ape1, datos.ape2?.trim()]
      .filter(Boolean)
      .join(' ');
  }
  return datos.nombre?.trim() || null;
}

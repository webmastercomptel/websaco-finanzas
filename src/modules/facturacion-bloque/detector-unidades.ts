// src/modules/facturacion-bloque/detector-unidades.ts
//
// Pure unit-per-page detection: no database, no PDF. Given the text of each page
// and a label pattern with one capture group, it groups the 1-indexed page
// numbers by unit code. Kept pure so the grouping rules (and the privacy guard
// below) are tested in isolation.

/**
 * The ONE normalization used to COMPARE unit codes: collapses inner whitespace,
 * trims and uppercases (`null`/`undefined` -> empty string). The code read from
 * the PDF and the codes of the coproperty's units must always go through it, or
 * they will never match. The result is never persisted.
 */
export function normalizarCodigoUnidad(
  valor: string | null | undefined,
): string {
  return (valor ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/** A page whose candidate matched a known unit but was refused by the privacy guard. */
export interface RechazoPorGuarda {
  /** 1-indexed page. */
  pagina: number;
  /** The REGISTERED code that was refused; never the printed text (it may carry personal data). */
  unidad: string;
}

export interface MapaPaginasUnidad {
  /**
   * Unit code -> 1-indexed pages. A `Map` and not a plain object on purpose: the
   * keys come out of an uploaded file, and `__proto__`/`constructor` must be
   * ordinary keys, not a way to touch the prototype.
   */
  unidades: Map<string, number[]>;
  /** 1-indexed pages where no unit was detected. */
  paginasSinMatch: number[];
  /** Pages refused by the privacy guard (with or without falling back to legacy). */
  rechazadasPorGuarda: RechazoPorGuarda[];
}

/** Text that labels the unit on each page ("ID" in the PDFs this adapter was built for). */
export const ETIQUETA_UNIDAD = 'ID';

/** Escapes regex metacharacters of literal text. */
function escaparRegex(texto: string): string {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the label regex for a label text: `<label>: <candidate>`
 * (case-insensitive, tolerant to spaces). The candidate starts with the legacy
 * alphabet (letters, digits, hyphen: `L-1`, `304T4`) and runs up to 63 more
 * characters without crossing a line break; `Torre A - 301 Total $100` is
 * resolved afterwards against the known units (see `construirMapaPaginas`).
 * A trailing `:` in the label is accepted and trimmed so it is not doubled.
 */
export function crearRegexEtiqueta(etiqueta: string): RegExp {
  const limpia = etiqueta.trim().replace(/:\s*$/, '');
  return new RegExp(
    `${escaparRegex(limpia)}:\\s*([A-Za-z0-9-][^\\r\\n]{0,63})`,
    'i',
  );
}

export const REGEX_ETIQUETA_POR_DEFECTO = crearRegexEtiqueta(ETIQUETA_UNIDAD);

/**
 * Set of known unit codes (normalized, deduplicated). Empty values are dropped.
 * No other character is excluded: codes live in a `Map`, never as object keys.
 */
export function construirConjuntoConocidas(
  unidades: ReadonlyArray<string | null | undefined>,
): Set<string> {
  const conocidas = new Set<string>();
  for (const bruta of unidades) {
    const unidad = normalizarCodigoUnidad(bruta);
    if (unidad) conocidas.add(unidad);
  }
  return conocidas;
}

/** First token of the legacy alphabet: the historical behaviour of the detector. */
const TOKEN_LEGACY = /^[A-Za-z0-9-]+/;

/**
 * Punctuation that, at the start of the token FOLLOWING a known prefix, means the
 * printed code goes on (`Torre A - 302`, `Local 2 / Norte`, `Torre A (302)`,
 * `Torre A #302`, `Torre A : 302`, `Torre A | 302`). `\p{Pd}` covers every
 * Unicode dash; `−` (minus sign) is `\p{Sm}`, so it is listed explicitly. Known
 * limit: it only detects punctuation, not continuation by plain words or digits.
 */
const PUNTUACION_DE_CONTINUACION = /^(?:\p{Pd}|[−/(#:,|])/u;

interface UnidadResuelta {
  /** Resolved code; `null` = the page stays unmatched. */
  unidad: string | null;
  /** Known unit whose match the privacy guard refused. */
  rechazada?: string;
}

/**
 * Resolves the unit code of a candidate captured after the label.
 *
 * 1. With known units: the LONGEST one that equals the normalized candidate or is
 *    a prefix of whole tokens, so `LOCAL 2` never matches `LOCAL 20`.
 *    Privacy guard: when that longest prefix is a STRICT prefix and the next token
 *    starts with continuation punctuation, the printed code is longer than the
 *    known unit (known `TORRE A`, printed `Torre A - 302`): handing it to
 *    `TORRE A` would show somebody else's invoice. It is refused (shorter
 *    prefixes are NOT tried) and detection falls to legacy. Deliberately fails
 *    safe: `301 - 2024` with `301` known is refused too — failures get reported,
 *    wrong deliveries do not happen.
 * 2. No match (or no known units): legacy. With the default regex, the first
 *    `[A-Za-z0-9-]+` token; with a custom regex, the whole normalized capture.
 *
 * Returns `unidad: null` when the candidate was refused by the guard and its
 * legacy code still equals a known unit: assigning it would be the same wrong
 * delivery.
 */
function resolverCodigo(
  captura: string,
  conocidas: ReadonlySet<string>,
  regexPorDefecto: boolean,
): UnidadResuelta {
  let rechazada: string | undefined;
  if (conocidas.size > 0) {
    const tokens = normalizarCodigoUnidad(captura).split(' ');
    for (let n = tokens.length; n > 0; n--) {
      const prefijo = tokens.slice(0, n).join(' ');
      if (!conocidas.has(prefijo)) continue;
      if (n < tokens.length && PUNTUACION_DE_CONTINUACION.test(tokens[n])) {
        rechazada = prefijo;
        break;
      }
      return { unidad: prefijo };
    }
  }
  let codigoLegacy = normalizarCodigoUnidad(captura);
  if (regexPorDefecto) {
    const legacy = TOKEN_LEGACY.exec(captura);
    if (legacy) codigoLegacy = normalizarCodigoUnidad(legacy[0]);
  }
  if (rechazada !== undefined && conocidas.has(codigoLegacy)) {
    return { unidad: null, rechazada };
  }
  return { unidad: codigoLegacy, rechazada };
}

/**
 * Builds the unit -> pages map from the text of each page. `textos[i]` is the
 * text of page `i + 1`. With several labels on one page the first wins. A page
 * whose candidate was refused by the privacy guard and whose legacy code equals
 * a known unit ends up in `paginasSinMatch`.
 *
 * Note: the extracted text has NO line breaks (the fragments are joined with
 * ' '), so a candidate is not delimited by line but by the known units.
 */
export function construirMapaPaginas(
  textos: string[],
  regexEtiqueta: RegExp = REGEX_ETIQUETA_POR_DEFECTO,
  conocidas: ReadonlySet<string> = new Set<string>(),
): MapaPaginasUnidad {
  const unidades = new Map<string, number[]>();
  const paginasSinMatch: number[] = [];
  const rechazadasPorGuarda: RechazoPorGuarda[] = [];
  const regexPorDefecto = regexEtiqueta === REGEX_ETIQUETA_POR_DEFECTO;

  textos.forEach((texto, indice) => {
    const pagina = indice + 1;
    const coincidencia = regexEtiqueta.exec(texto);
    if (!coincidencia || !coincidencia[1]) {
      paginasSinMatch.push(pagina);
      return;
    }
    const { unidad, rechazada } = resolverCodigo(
      coincidencia[1],
      conocidas,
      regexPorDefecto,
    );
    if (rechazada !== undefined) {
      rechazadasPorGuarda.push({ pagina, unidad: rechazada });
    }
    if (unidad === null) {
      paginasSinMatch.push(pagina);
      return;
    }
    const paginas = unidades.get(unidad);
    if (paginas) paginas.push(pagina);
    else unidades.set(unidad, [pagina]);
  });

  return { unidades, paginasSinMatch, rechazadasPorGuarda };
}

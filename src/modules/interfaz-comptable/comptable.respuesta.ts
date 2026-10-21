// src/modules/interfaz-comptable/comptable.respuesta.ts

/** One rejected document, as Comptable reports it (`"FV 4152"` + reason). */
export interface ErrorAsientoComptable {
  asiento: string;
  motivo: string;
}

/** What this side needs out of any Comptable response body. */
export interface CamposRespuestaComptable {
  /** Machine code of a 409 (`LOTE_YA_RECIBIDO`, `LOTE_INTERVENIDO`…). */
  codigo: string | null;
  /** Comptable's own lote id, sent back on a duplicate (`LOTE_YA_RECIBIDO`). */
  loteId: string | null;
  /** Per-document errors of a 400; `[]` when the body carries none. */
  errores: ErrorAsientoComptable[];
  /** Human sentence, shown verbatim; null when the body carries none. */
  mensaje: string | null;
}

const esObjeto = (valor: unknown): valor is Record<string, unknown> =>
  typeof valor === 'object' && valor !== null && !Array.isArray(valor);

const textoNoVacio = (valor: unknown): string | null =>
  typeof valor === 'string' && valor.trim() !== '' ? valor : null;

const aErrores = (valor: unknown): ErrorAsientoComptable[] | null => {
  if (!Array.isArray(valor)) return null;
  return valor.filter(esObjeto).map((e) => ({
    asiento: textoNoVacio(e.asiento) ?? textoNoVacio(e.fila) ?? '',
    motivo:
      textoNoVacio(e.motivo) ??
      textoNoVacio(e.mensaje) ??
      textoNoVacio(e.message) ??
      '',
  }));
};

/** A Nest validation error carries `message` as a list of sentences. */
const aMensaje = (valor: unknown): string | null => {
  if (Array.isArray(valor)) {
    const partes = valor.map(textoNoVacio).filter((p): p is string => !!p);
    return partes.length > 0 ? partes.join('; ') : null;
  }
  return textoNoVacio(valor);
};

/**
 * Pulls `codigo`, `loteId`, `errores` and the human message out of a Comptable
 * response body, wherever they sit. Deliberately tolerant: Comptable's error
 * envelope was being built at the same time as this client, so the fields are
 * looked up at the top level, under `data`, and under `message`/`error` when
 * those are objects (a Nest `HttpException` thrown with an object puts it in
 * one of those places depending on the exception filter). First hit wins, in
 * that order. This is the ONE place to adjust if the envelope settles
 * differently; nothing else reads a Comptable body field by name except the
 * success payload (`data`).
 *
 * Never throws: anything that is not an object (empty body, HTML from a proxy,
 * plain text) yields all-null fields.
 */
export function leerRespuestaComptable(
  cuerpo: unknown,
): CamposRespuestaComptable {
  const candidatos: Record<string, unknown>[] = [];
  if (esObjeto(cuerpo)) {
    candidatos.push(cuerpo);
    for (const clave of ['data', 'message', 'error']) {
      const anidado = cuerpo[clave];
      if (esObjeto(anidado)) candidatos.push(anidado);
    }
  }

  const primero = <T>(
    leer: (c: Record<string, unknown>) => T | null,
  ): T | null => {
    for (const candidato of candidatos) {
      const valor = leer(candidato);
      if (valor !== null) return valor;
    }
    return null;
  };

  return {
    codigo: primero((c) => textoNoVacio(c.codigo) ?? textoNoVacio(c.code)),
    loteId: primero((c) => textoNoVacio(c.loteId)),
    errores: primero((c) => aErrores(c.errores)) ?? [],
    mensaje: primero((c) => aMensaje(c.message) ?? aMensaje(c.mensaje)),
  };
}

/** The success payload: the `{ statusCode, data }` envelope unwrapped, or the
 *  body itself when it has no envelope. */
export function datosRespuestaComptable(cuerpo: unknown): unknown {
  if (esObjeto(cuerpo) && 'data' in cuerpo) return cuerpo.data;
  return cuerpo;
}

/** Parses a raw response text as JSON; `null` for anything unparsable, so the
 *  caller classifies by status code alone. */
export function parsearCuerpo(texto: string): unknown {
  if (texto.trim() === '') return null;
  try {
    return JSON.parse(texto) as unknown;
  } catch {
    return null;
  }
}

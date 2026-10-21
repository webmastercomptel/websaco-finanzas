// src/modules/inmuebles/codigo-parecido.ts

/**
 * A key that two unit codes share when a person would likely read them as the
 * same unit typed differently: lowercase, leading zeros stripped from EVERY
 * run of digits, and the separators (spaces and `-`, `_`, `.`, `/`) dropped —
 * except a separator run BETWEEN two digits, which becomes a single `|` marker
 * that is kept.
 *
 * The marker is what keeps tower/floor codes apart: "1-23" ("1|23") and "12-3"
 * ("12|3") are different units, as are "A-1-01" ("a1|1") and "A-10-1"
 * ("a10|1"); dropping every separator would have collided them. Elsewhere a
 * separator carries no meaning: "A-01" and "a1" share "a1", "301" and "0301"
 * share "301", and "301" and "3010" do not.
 *
 * Used only to WARN in the import preview. It deliberately never merges
 * anything: "0301" and "301" remain DIFFERENT codes on purpose (the stored code
 * is what WebSaco3 links by, and a building may really have both), so the
 * import still treats them as two units — the warning just gives the person a
 * chance to notice a typo before loading.
 *
 * A run made only of zeros keeps one ("000" -> "0", "A-00" -> "a0"): zero is a
 * value, not padding. An empty or non-string input yields an empty key;
 * callers must skip those (an empty key would "match" every other empty one).
 */
export const claveParecida = (codigo: unknown): string => {
  if (typeof codigo !== 'string') return '';
  // Zeros go from each digit run first, while the separators still split the
  // runs ("A-01-002" is "01" and "002", not one merged "01002").
  return codigo
    .toLowerCase()
    .replace(/\d+/g, (digitos) => digitos.replace(/^0+(?=\d)/, ''))
    .replace(/(\d)[\s\-_./]+(?=\d)/g, '$1|')
    .replace(/[\s\-_./]+/g, '');
};

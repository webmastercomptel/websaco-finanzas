// src/modules/inmuebles/codigo-parecido.ts

/**
 * A key that two unit codes share when a person would likely read them as the
 * same unit typed differently: lowercase, with spaces and the separators
 * `-`, `_`, `.`, `/` removed, and leading zeros stripped from EVERY run of
 * digits.
 *
 * "A-01" and "a1" share a key ("a1"); so do "Torre 2 - 0301" and "torre2301"
 * ("torre2301"). "301" and "3010" do not ("301" vs "3010"), and "301" and
 * "0301" DO ("301").
 *
 * Used only to WARN in the import preview. It deliberately never merges
 * anything: "0301" and "301" remain DIFFERENT codes on purpose (the stored code
 * is what WebSaco3 links by, and a building may really have both), so the
 * import still treats them as two units — the warning just gives the person a
 * chance to notice a typo before loading.
 *
 * A run made only of zeros keeps one ("000" -> "0", "A-00" -> "a0"): zero is a
 * value, not padding. An empty or non-string input yields an empty key; callers must skip those
 * (an empty key would "match" every other empty one).
 */
export const claveParecida = (codigo: unknown): string => {
  if (typeof codigo !== 'string') return '';
  // Zeros are stripped from each run of digits BEFORE the separators go, so
  // "A-01-002" is two runs ("01", "002") and not one merged "01002".
  return codigo
    .toLowerCase()
    .replace(/\d+/g, (digitos) => digitos.replace(/^0+(?=\d)/, ''))
    .replace(/[\s\-_./]+/g, '');
};

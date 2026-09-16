/**
 * Character-count truncation heuristic for the wide, dense reports (17+
 * columns at 6.5pt) where a cell must never wrap to a second line — a
 * wrapped cell breaks row-height alignment against its single-line
 * siblings, worse than a truncated one. Deferred back when `Tabla` first
 * shipped (see its docblock) until a view that actually needed it arrived.
 *
 * Not pixel-exact: react-pdf's Helvetica is a PDF standard-14 font (AFM
 * metrics), and `fontkit` — this project's text-measurement library —
 * only parses OpenType/TrueType font files, not AFM, so precisely
 * replicating pdf-lib's `font.widthOfTextAtSize` isn't available without
 * embedding an actual Helvetica-equivalent TTF. `0.52 * fontSize` is a
 * standard average-glyph-width approximation for Helvetica — good enough
 * for a defensive truncation on short codes/names, not a layout-critical
 * measurement.
 */
export function truncarTexto(
  texto: string,
  maxWidthPt: number,
  fontSize: number,
  anchoPromedioChar = 0.52,
): string {
  const maxChars = Math.max(
    1,
    Math.floor(maxWidthPt / (fontSize * anchoPromedioChar)),
  );
  if (texto.length <= maxChars) return texto;
  return texto.length <= 1
    ? texto
    : `${texto.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Shared text-color tokens for every react-pdf component — one gray, one
 * green, one red, used everywhere instead of each component picking its
 * own approximation. Grew out of real drift: `#666666`, `#767a80`,
 * `#999999` and `#4d4d4d` had each shown up as "the muted label gray" in a
 * different file, and two different reds (`#c0392b`, `#c4401f`) had shown
 * up as "the warning/danger red" — inconsistent enough to notice side by
 * side on the same page.
 *
 * Hand-picked hex approximations of the frontend's own design tokens
 * (`--muted-foreground`, `--success`, `--destructive` in `index.css`) —
 * react-pdf's color parser doesn't accept `oklch()`, so these can't be the
 * tokens themselves, only a match for the same intent.
 */
export const TEXTO_MUTED = '#6b7280';
export const VERDE_OK = '#15803d';
export const ROJO_DANGER = '#b91c1c';

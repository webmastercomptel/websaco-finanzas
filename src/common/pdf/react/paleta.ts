/**
 * Shared text-color tokens for every react-pdf component — one green, one
 * red, used everywhere instead of each component picking its own
 * approximation. Everything else stays plain black by design (explicit
 * product decision: one black throughout, color reserved for what actually
 * carries meaning — a status, a discount). A "muted gray" label color was
 * tried first and dropped: `#666666`, `#767a80`, `#999999` and `#4d4d4d`
 * had each shown up as "the muted label gray" in a different file, drifting
 * enough to notice side by side on the same page, and simplifying to one
 * black everywhere removed the drift instead of chasing it.
 *
 * Hand-picked hex approximations of the frontend's own design tokens
 * (`--success`/`--destructive` in `index.css`) — react-pdf's color parser
 * doesn't accept `oklch()`, so these can't be the tokens themselves, only a
 * match for the same intent.
 */
export const VERDE_OK = '#15803d';
export const ROJO_DANGER = '#b91c1c';

/** One zebra-striping background for every table — `CuerpoFactura` and
 *  `TablaResumen` each had their own slightly different gray (`#f5f5f5`,
 *  `#f7f7f7`) before this; same drift as the muted-gray text color, same
 *  fix. */
export const FONDO_ZEBRA = '#f7f7f7';

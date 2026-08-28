/**
 * API CONTRACT — the Spanish-shaped payloads this backend serves.
 *
 * THE LAW, in one sentence: persistence is in English, the API is in Spanish,
 * and a mapper is the only thing allowed to cross between them.
 *
 * Concretely:
 *  - Mongo schemas, fields and service code use English identifiers.
 *  - Every shape returned to a client is declared HERE, in Spanish.
 *  - Each module owns a `<module>.mapper.ts` of pure functions that turn its
 *    documents into these shapes. Controllers return mapper output, never a
 *    Mongoose document — leaking a document leaks the persistence model and
 *    ties the frontend to it forever.
 *
 * Conventions every shape follows:
 *  - `id` is the Mongo `_id` rendered as a string.
 *  - A human-readable identifier (invoice number, receipt number) lives in
 *    `codigo`, never in `id`.
 *  - Dates are ISO 8601 strings. Formatting for humans is the frontend's job.
 *  - Money is never a formatted string. See the note on Monto below.
 *  - References to things this system does not own (coproperties, units) are
 *    flat id strings, because there is no local collection to populate.
 *
 * The financial document shapes (Factura, Recibo, NotaCredito, OtraNota) are
 * NOT here yet: they are designed together with their Mongo schemas, once the
 * domain questions behind them have been answered. Adding a speculative
 * `Factura` here before that would freeze guesses into the contract.
 */

/** An ISO 8601 timestamp, e.g. "2026-08-27T14:32:00.000Z". */
export type IsoDate = string;

/**
 * A monetary amount.
 *
 * Deliberately an alias rather than `number` so the representation can be
 * settled once, in one place, when the invoice schema is designed — floating
 * point pesos and integer centavos are both defensible and the choice must be
 * made deliberately, not inherited from whoever writes the first module.
 * Until then, code against `Monto` and the decision stays cheap.
 */
export type Monto = number;

/** Standard envelope for a paginated listing. */
export interface Paginado<T> {
  items: T[];
  total: number;
  pagina: number;
  porPagina: number;
}

/* ── Identidad ─────────────────────────────────────────────────── */

/**
 * A coproperty as the picker needs it: enough to recognise and choose one.
 *
 * `codigo` is here because a managing company may run ten or more buildings
 * with similar names, and the code is what its staff actually say out loud.
 */
export interface CopropiedadResumen {
  id: string;
  codigo: string;
  nombre: string;
}

/**
 * Who the caller is, plus the coproperties they may work on.
 *
 * This is what the app asks for right after signing in, and it must not
 * require an active coproperty — it is what lets the caller choose one.
 *
 * An empty `copropiedades` is a real state, not an error: somebody with a valid
 * session and no assignment yet. The client must render that as its own thing,
 * distinct from a failed request.
 */
export interface AuthMe {
  uid: string;
  email: string;
  nombre: string | null;
  esAdministradorPlataforma: boolean;
  copropiedades: CopropiedadResumen[];
}

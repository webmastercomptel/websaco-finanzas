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

/* ── Inmuebles ─────────────────────────────────────────────────── */

/** The party responsible for a unit, as a unit listing needs to show them. */
export interface TitularResumen {
  id: string;
  nombre: string;
  identificacion: string | null;
}

export interface Inmueble {
  id: string;
  codigo: string;
  bloque: string | null;
  zona: string | null;
  uso: string | null;
  /** Square metres. */
  area: number | null;
  /** Share of the building, as a percentage. */
  coeficiente: number | null;
  /**
   * Who answers for this unit's charges today. Null while nobody has been
   * recorded — a building is often loaded before its ownership papers are.
   */
  titular: TitularResumen | null;
  tipoTitular: 'propietario' | 'arrendatario';
  resideEnElInmueble: boolean;
  estadoCartera: 'al_dia' | 'juridico' | 'dificil_recaudo';
  estado: 'activo' | 'inactivo';
}

/** One row's outcome from a bulk import that could not be created. */
export interface ErrorImportacionInmueble {
  /** 1-based, matching the row order the file was uploaded in. */
  fila: number;
  codigo: string | null;
  mensaje: string;
}

/**
 * Result of importing a batch of units — and, inline, their titulares — at
 * once. Rows are independent: one bad row does not abort the rest, because a
 * 400-unit file with three typos should not have to be re-uploaded whole.
 */
export interface ResultadoImportacionInmuebles {
  total: number;
  creados: number;
  errores: ErrorImportacionInmueble[];
}

/* ── Terceros ──────────────────────────────────────────────────── */

/**
 * A person or company the system bills, collects from, or names on a
 * document — kept apart from Inmueble so correcting a typo today never
 * rewrites what an issued document says. See the note on the Tercero schema.
 */
export interface Tercero {
  id: string;
  tipoPersona: 'natural' | 'juridica';
  /** Full name for a person, trade name for a company. */
  nombre: string;
  tipoIdentificacion: string | null;
  numeroIdentificacion: string | null;
  digitoVerificacion: string | null;
  email: string | null;
  telefono: string | null;
  direccion: string | null;
  ciudad: string | null;
  /**
   * What the tax authority requires beyond a name and a general
   * identification. Kept separate from the fields above — see the note on
   * the schema for why collapsing them would be wrong.
   */
  facturacionElectronica: {
    tipoIdentificacion: string | null;
    numeroIdentificacion: string | null;
    digitoVerificacion: string | null;
    /** Economic-activity code (CIIU). */
    codigoCiiu: string | null;
    regimenVentas: string | null;
  };
  responsabilidadesFiscales: string[];
  retieneRenta: boolean;
  retieneIca: boolean;
  estado: 'activo' | 'inactivo';
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

/* ── Entidades administradoras y copropiedades (platform config) ── */

/**
 * Platform-operator surface: who administers what. A customer's own
 * administrator never sees or edits these shapes — see PlatformAdminGuard on
 * the backend. This mirrors the 'Instalación' panel of the system this
 * replaces.
 */

/** A company that manages several coproperties. */
export interface EntidadAdministradora {
  id: string;
  codigo: string;
  nombre: string;
  nit: string | null;
  digitoVerificacion: string | null;
  email: string | null;
  telefono: string | null;
  estado: 'activo' | 'inactivo';
}

/** The full record of a coproperty, for the platform configuration screen. */
export interface Copropiedad {
  id: string;
  codigo: string;
  nombre: string;
  nit: string | null;
  digitoVerificacion: string | null;
  direccion: string | null;
  ciudad: string | null;
  telefono: string | null;
  email: string | null;
  /** Null when the building has no managing company on file. */
  entidadAdministradora: { id: string; nombre: string } | null;
  /**
   * An internal label only — "Junta de copropietarios", "Portería" — never an
   * authorization record. Who actually administers this building directly
   * (when `entidadAdministradora` is null) is answered by Usuarios: an
   * Account holding an assignment scoped to this coproperty.
   */
  nombreAdministrador: string | null;
  estado: 'activo' | 'inactivo';
  /** Whether this building ALSO uses the building-management system. */
  usaGestionEdificios: boolean;
  cuentaContableCartera: string | null;
}

/* ── Conceptos de cobro ("Cargos") ─────────────────────────────────
 *
 * Qué se le puede cobrar a una copropiedad — cuota de administración,
 * intereses de mora, multas, parqueadero — reemplazando los doce slots fijos
 * ("Cargo 1".."Cargo 12") del sistema anterior con filas: una copropiedad
 * declara tantos como necesite. Ver el schema de ConceptoCobro.
 *
 * Editado hoy desde la pantalla de plataforma de la copropiedad
 * (PlatformAdminGuard), como primer paso: es un recurso de tenant (tiene
 * `copropiedadId`) y el CASL subject `ConceptoCobro` ya está reservado en
 * permission-map.ts para cuando el administrador de cada edificio lo
 * gestione con su propio permiso, sin pasar por PlatformAdminGuard.
 */
export interface ConceptoCobro {
  id: string;
  copropiedadId: string;
  nombre: string;
  tipo: 'administracion' | 'intereses' | 'otro';
  tasaImpuesto: number;
  orden: number;
  activo: boolean;
  cuentaContableIngreso: string | null;
}

/* ── Usuarios (platform config) ───────────────────────────────────
 *
 * Who may sign in and operate this system, and where. Platform-operator
 * surface, same as Entidades/Copropiedades — see PlatformAdminGuard.
 */

/**
 * One grant, describing where a user may work and what they may do there.
 *
 * A simplification of the underlying model on purpose: `Asignacion` supports
 * several grants per account (a company plus one extra building outside it),
 * but this screen manages exactly one — the same shape the legacy system's
 * user form had (one row, one role, one coproperty or entity). Nothing in the
 * data model stops a second grant existing; there is just no screen for it
 * yet.
 */
export interface AsignacionResumen {
  alcance: 'copropiedad' | 'entidad';
  copropiedadId: string | null;
  copropiedadNombre: string | null;
  entidadId: string | null;
  entidadNombre: string | null;
  permisos: string[];
}

/**
 * A person who signs in to operate Finanzas — always staff. Unit owners and
 * tenants are `Tercero` records and never reach this screen; see Tercero and
 * Account for why.
 *
 * `asignacion` is null for a platform administrator (they need none — see
 * `rulesFromPermissionKeys`) and for a person nobody has assigned anywhere
 * yet, which is a real, unremarkable state: "authenticated but powerless" is
 * the correct default the whole authorization layer is built around.
 */
export interface Usuario {
  id: string;
  nombre: string;
  email: string;
  esAdministradorPlataforma: boolean;
  estado: 'activo' | 'inactivo';
  asignacion: AsignacionResumen | null;
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

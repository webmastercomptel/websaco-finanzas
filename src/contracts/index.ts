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
 * The financial document shapes are added one at a time, together with their
 * Mongo schema, once the domain questions behind each has been answered.
 * `Factura`, `Recibo`, `NotaCredito` and `NotaDebito` are here now.
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
  /** Free-text notes — see the note on `Inmueble.notes` in the schema. */
  observaciones: string | null;
  /** ISO 8601 — when this unit's record was last saved. */
  fechaActualizacion: IsoDate;
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
  /** Units of this coproperty erased right before this import — every
   *  import replaces the whole roster, see `InmueblesService.importar`. */
  eliminadosAntes: number;
  /** Codes left untouched because they already have a Factura issued —
   *  never deleted, only skipped. */
  bloqueadosPorFactura: string[];
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
  /** Split name parts — see the note on `Tercero.name` in the schema.
   *  `nom1`/`ape1` for `natural`, `razonSocial` for `juridica`; null when
   *  the party was loaded without them (e.g. the Excel import). */
  nom1: string | null;
  nom2: string | null;
  ape1: string | null;
  ape2: string | null;
  razonSocial: string | null;
  tipoIdentificacion: string | null;
  numeroIdentificacion: string | null;
  digitoVerificacion: string | null;
  email: string | null;
  telefono: string | null;
  direccion: string | null;
  ciudad: string | null;
  /** DANE municipio/departamento codes paired with `ciudad` — see the note
   *  on `Tercero.cityCode` in the schema. */
  ciudadCodigo: string | null;
  ciudadDepartamentoCodigo: string | null;
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

/* ── Facturación ───────────────────────────────────────────────── */

/** The party a Factura was issued to, frozen at the moment of emission. */
export interface TitularFactura {
  nombre: string;
  tipoIdentificacion: string | null;
  numeroIdentificacion: string | null;
  digitoVerificacion: string | null;
  direccion: string | null;
  ciudad: string | null;
  email: string | null;
}

/** One invoice line, everything about its concept frozen at emission. */
export interface FacturaLinea {
  conceptoId: string;
  nombreConcepto: string;
  tipoConcepto: 'administracion' | 'intereses' | 'otro';
  origen: 'recurrente' | 'novedad' | 'interes';
  /**
   * Id of the NovedadLote this line came from or was overridden by, null for
   * a recurrente/interes line never edited manually. Only meaningful while
   * the parent Lote is still open — the Liquidación screen uses it to decide
   * whether editing this line means PATCHing this id or POSTing a brand-new
   * override.
   */
  novedadId: string | null;
  valorBase: Monto;
  tasaImpuesto: number;
  valorImpuesto: Monto;
  valorTotal: Monto;
  /** This concept's saldo de cartera immediately before/after this line —
   *  frozen at the moment the line was built, never recomputed later. */
  saldoAnterior: Monto;
  nuevoSaldo: Monto;
}

/** A sales invoice ("FV"), only ever created already numbered. */
export interface Factura {
  id: string;
  loteId: string;
  inmuebleId: string;
  inmuebleCodigo: string;
  terceroId: string | null;
  titular: TitularFactura | null;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  fechaEmision: IsoDate;
  fechaVencimiento: IsoDate;
  periodoDesde: IsoDate;
  periodoHasta: IsoDate;
  lineas: FacturaLinea[];
  subtotal: Monto;
  totalImpuestos: Monto;
  total: Monto;
  saldoPendiente: Monto;
  estado: 'emitida' | 'anulada';
}

/**
 * One billing run. `previsualizacion` and `novedades` are intentionally NOT
 * sent in full here — only counts. The full `FacturaPreliminar` list is what
 * the (future) Liquidación screen needs and is out of scope for this
 * backend-only plan; exposing counts now avoids a large, unused payload
 * shape that would need revisiting anyway once that screen's real needs are
 * known (see spec §8).
 */
export interface LoteFacturacion {
  id: string;
  numero: number;
  estado: 'borrador' | 'liquidado' | 'consolidado';
  fechaFacturacion: IsoDate;
  fechaVencimiento: IsoDate;
  periodoDesde: IsoDate;
  periodoHasta: IsoDate;
  descuentoProntoPago: number;
  diasGraciaDescuento: number;
  interesMora: number;
  /** Not a ceiling on the mora amount — the minimum overdue balance before
   *  mora is calculated at all. See the note on `lateInterestCap` in
   *  lote-facturacion.schema.ts. */
  topeInteresMora: number | null;
  fechaLimiteDescuento: IsoDate;
  fechaSuspension: IsoDate;
  totalNovedades: number;
  totalPrevisualizacion: number;
  resumen: {
    montoTotal: Monto;
    totalFacturas: number;
    totalInmuebles: number;
  } | null;
}

/** One unit's computed invoice line as it stands in a Lote's previsualización. */
export interface FacturaPreliminar {
  inmuebleId: string;
  inmuebleCodigo: string;
  terceroId: string | null;
  titular: TitularFactura | null;
  lineas: FacturaLinea[];
  subtotal: Monto;
  totalImpuestos: Monto;
  total: Monto;
}

/**
 * `LoteFacturacion` plus the full previsualización array — what `GET
 * /lotes/:id` returns so the Liquidación screen can render its table.
 * `GET /lotes` (the listing) still returns lean `LoteFacturacion`, since
 * embedding every listed lote's full preview array would be wasted payload.
 */
export interface LoteFacturacionDetalle extends LoteFacturacion {
  previsualizacion: FacturaPreliminar[];
}

/** One row's outcome from consolidando a Lote that could not be numbered. */
export interface ErrorConsolidacion {
  /** 1-based, matching the row order in the Lote's `previsualizacion`. */
  fila: number;
  inmuebleCodigo: string;
  mensaje: string;
}

/**
 * Result of wiping every Lote/Factura (and their derived asientos/saldos)
 * of the one hardcoded test coproperty, so its billing cycle can be
 * replayed from zero. See `ReiniciarCicloService` for the safety checks.
 */
export interface ResultadoReinicioCiclo {
  lotesEliminados: number;
  facturasEliminadas: number;
  asientosEliminados: number;
  saldosEliminados: number;
}

/* ── Consulta de Facturación (reporte de lote) ────────────────────── */

/**
 * One concept's aggregate across a whole lote — dynamic, derived from
 * whichever ConceptoCobro rows actually appear on at least one Factura of
 * the lote. Never the legacy fixed twelve-slot list; a coproperty with 3
 * concepts gets 3 entries here, one with 20 gets 20.
 */
export interface TotalConceptoLote {
  conceptoId: string;
  nombreConcepto: string;
  monto: Monto;
  /** Sum of this concept's own `taxAmount` across the lote — 0 for a
   *  concept that never carries tax. Tells the frontend which concept
   *  column(s) need their own adjoining "IVA" column, so a taxed cargo's
   *  IVA shows right next to it instead of only in the aggregate below. */
  montoIva: Monto;
}

/**
 * One invoice row. `valoresPorConcepto` is keyed by `conceptoId` — the same
 * id space as `totalesPorConcepto` — so the frontend pivots into columns
 * without either side ever naming a concept. A concept this invoice has no
 * line for is simply absent from the map, not zero-filled.
 *
 * `valoresPorConcepto` carries each concept's BASE amount only — same
 * convention as the Factura PDF's "Cargos del Mes" column — so a taxed
 * concept's tax is never silently folded in there. `valoresIvaPorConcepto`
 * (same key space, same "absent means no line" rule) is what makes the
 * row's `total` reconcile with what's actually shown: sum of every
 * `valoresPorConcepto` entry plus every `valoresIvaPorConcepto` entry equals
 * `total`.
 */
export interface FilaConsultaFacturacion {
  inmuebleId: string;
  inmuebleCodigo: string;
  tipoDocumento: 'FV';
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  fechaFactura: IsoDate;
  fechaVence: IsoDate;
  valoresPorConcepto: Record<string, Monto>;
  valoresIvaPorConcepto: Record<string, Monto>;
  subtotal: Monto;
  totalImpuestos: Monto;
  total: Monto;
}

/** Response of `GET /lotes/:id/consulta-facturacion`. */
export interface RespuestaConsultaFacturacion {
  loteId: string;
  loteNumero: number;
  loteEstado: 'borrador' | 'liquidado' | 'consolidado';
  fechaFacturacion: IsoDate;
  fechaVencimiento: IsoDate;
  totalesPorConcepto: TotalConceptoLote[];
  subtotal: Monto;
  totalImpuestos: Monto;
  total: Monto;
  filas: FilaConsultaFacturacion[];
}

/* ── Recibos de Caja ───────────────────────────────────────────── */

/** How a receipt's money arrived. */
export type MedioPago = 'transferencia' | 'cheque' | 'pse' | 'efectivo';

/** Why a Recibo was voided — a fixed list, matching the mockup's
 *  voiding-reason options (design §4). */
export type MotivoAnulacionRecibo =
  | 'error_digitacion'
  | 'error_facturacion'
  | 'duplicado'
  | 'ajuste_contrato'
  | 'otro';

/**
 * A cash receipt ("RC"). `montoAplicado`/`montoSinAplicar` are the only
 * fields that move after creation — see the note on the Recibo schema.
 */
export interface Recibo {
  id: string;
  inmuebleId: string;
  terceroId: string;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  montoRecibido: Monto;
  fechaRecibo: IsoDate;
  medioPago: MedioPago;
  cuentaDestino: string;
  referencia: string | null;
  observaciones: string | null;
  montoAplicado: Monto;
  montoSinAplicar: Monto;
  estado: 'activo' | 'anulado';
  motivoAnulacion: MotivoAnulacionRecibo | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
}

/**
 * One cruce: one application of a Recibo OR a Nota Crédito against a
 * document. `sourceType` discriminates which kind of document made the
 * application — the same row shape serves both, which is what lets the
 * (future) Confirmación y Cruce screen list them side by side (design §3.1).
 * Only `'FV'` (Factura) and `'ND'` (Nota Débito) are implemented as targets.
 */
/** This application's own share of one concepto of the target document —
 *  same breakdown the accounting ledger's per-line credit already uses, so
 *  a Recibo/Nota Crédito detail screen can show "cargo por cargo" exactly
 *  like a Factura's own line table does. */
export interface DetalleConceptoAplicacion {
  conceptoId: string;
  nombreConcepto: string;
  monto: Monto;
}

export interface AplicacionCartera {
  id: string;
  sourceType: 'RC' | 'NC' | 'NA';
  sourceId: string;
  tipoDocumento: 'FV' | 'ND';
  documentoId: string;
  /** The target document's own printed number (e.g. "FV-1") — resolved for
   *  display, never stored on this row itself. `null` when the document
   *  can no longer be resolved (in practice never expected, since financial
   *  documents are never deleted). */
  numeroDocumento: string | null;
  montoAplicado: Monto;
  detalleConceptos: DetalleConceptoAplicacion[];
  estado: 'activa' | 'revertida';
  fecha: IsoDate;
}

/**
 * `Recibo` plus the full list of applications it has made — what
 * `GET /recibos/:id` returns. `GET /recibos` (the listing) keeps using lean
 * `Recibo`, same pattern as `LoteFacturacionDetalle`.
 */
export interface ReciboDetalle extends Recibo {
  aplicaciones: AplicacionCartera[];
}

/** One line of `aplicaciones` in `CrearReciboDto`/`AplicarReciboDto` — the
 *  caller's requested cruce against one document. */
export interface AplicacionSolicitada {
  tipoDocumento: 'FV' | 'ND';
  documentoId: string;
  montoAplicado: Monto;
}

/** One document FIFO auto-application could not apply, and why (design §6,
 *  "FIFO automatic mode is best-effort"). */
export interface ErrorAplicacion {
  documentoId: string;
  mensaje: string;
}

/**
 * Result of an application call — manual or FIFO. `errores` is only ever
 * populated in FIFO mode: manual mode either succeeds completely or the
 * whole request is rejected (design §6).
 */
export interface ResultadoAplicacion {
  aplicadas: AplicacionCartera[];
  montoSinAplicar: Monto;
  errores: ErrorAplicacion[];
}

/* ── Notas Crédito ─────────────────────────────────────────────── */

/** Why a Nota Crédito was issued — a fixed list, matching the mockup's
 *  reason options (design §3.2). */
export type MotivoNotaCredito =
  'error_facturacion' | 'descuento_comercial' | 'anulacion_documento' | 'otro';

/** Why a Nota Crédito was voided — same catalog as a Recibo's void (design
 *  §5/§8; no domain-specific list was requested for this document). */
export type MotivoAnulacionNotaCredito =
  | 'error_digitacion'
  | 'error_facturacion'
  | 'duplicado'
  | 'ajuste_contrato'
  | 'otro';

/** One line of `distribucion` — how much of `montoTotal` corrects a given
 *  concepto on the anchor invoice (design §3.2/§6, "per-concepto cap"). */
export interface DistribucionNotaCredito {
  conceptoId: string;
  monto: Monto;
}

/**
 * A credit note ("NC"), always issued against exactly one anchor invoice —
 * unlike `Recibo` (design §3.2). `montoAplicado`/`montoSinAplicar` are the
 * only fields that move after creation, same pattern as `Recibo`.
 */
export interface NotaCredito {
  id: string;
  inmuebleId: string;
  terceroId: string | null;
  facturaId: string;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  motivo: MotivoNotaCredito;
  montoTotal: Monto;
  distribucion: DistribucionNotaCredito[];
  montoAplicado: Monto;
  montoSinAplicar: Monto;
  observaciones: string | null;
  estado: 'activo' | 'anulado';
  motivoAnulacion: MotivoAnulacionNotaCredito | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
}

/**
 * `NotaCredito` plus the full list of applications it has made — what
 * `GET /notas-credito/:id` returns. `GET /notas-credito` (the listing) keeps
 * using lean `NotaCredito`, same pattern as `ReciboDetalle`.
 */
export interface NotaCreditoDetalle extends NotaCredito {
  aplicaciones: AplicacionCartera[];
}

/* ── Notas Débito ─────────────────────────────────────────────── */

/** A debit note ("ND"), always issued against a concepto for an inmueble —
 *  used to charge amounts that are not part of a regular invoice (design §2). */
export interface NotaDebito {
  id: string;
  inmuebleId: string;
  terceroId: string | null;
  conceptoId: string;
  descripcion: string | null;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  fechaEmision: IsoDate;
  total: Monto;
  saldoPendiente: Monto;
  estado: 'emitida' | 'anulada';
  motivoAnulacion: MotivoAnulacionNotaCredito | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
}

/**
 * `NotaDebito` plus the full list of applications it has received — what
 * `GET /notas-debito/:id` returns. `GET /notas-debito` (the listing) keeps
 * using lean `NotaDebito`, same pattern as `ReciboDetalle`.
 */
export interface NotaDebitoDetalle extends NotaDebito {
  aplicaciones: AplicacionCartera[];
}

/* ── Notas de Anticipo ────────────────────────────────────────── */

/** Why a Nota de Anticipo was voided — same shape as the other documents'
 *  void catalogs (design consistency, no domain-specific list requested). */
export type MotivoAnulacionNotaAnticipo =
  'error_digitacion' | 'ajuste_contrato' | 'otro';

/**
 * A "Nota de Anticipo" ("NA") — applies a Recibo's leftover
 * `montoSinAplicar` against open cartera LATER, as its own auditable
 * document, from the Anticipos module (never from the Recibo itself — see
 * `Recibo`'s own note on why there is no `/recibos/:id/aplicar`).
 */
export interface NotaAnticipo {
  id: string;
  inmuebleId: string;
  terceroId: string | null;
  reciboOrigenId: string;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  fechaEmision: IsoDate;
  montoAplicado: Monto;
  estado: 'activo' | 'anulado';
  motivoAnulacion: MotivoAnulacionNotaAnticipo | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
}

/**
 * `NotaAnticipo` plus the cargo-por-cargo breakdown of what it applied —
 * what `GET /notas-anticipo/:id` returns, same pattern as
 * `NotaDebitoDetalle`.
 */
export interface NotaAnticipoDetalle extends NotaAnticipo {
  aplicaciones: AplicacionCartera[];
}

/* ── Notas Contables ──────────────────────────────────────────── */

/**
 * An accounting reclassification note ("NT") — moves an amount between two
 * ConceptoCobro balances within one inmueble's cartera. One-shot event: no
 * outstandingBalance, no application lifecycle (design §3).
 */
export interface NotaContable {
  id: string;
  inmuebleId: string;
  conceptoOrigenId: string;
  conceptoDestinoId: string;
  monto: Monto;
  descripcion: string;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  estado: 'activo' | 'anulado';
  motivoAnulacion: MotivoAnulacionNotaCredito | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
}

/* ── Auxiliar de Cartera (kardex) ────────────────────────────── */

export type TipoDocumentoKardex = 'FC' | 'RC' | 'NC' | 'ND' | 'NT' | 'NA';

/** One row in the chronological ledger for an inmueble. */
export interface MovimientoKardex {
  fecha: string;
  tipo: TipoDocumentoKardex;
  numeroCompleto: string;
  concepto: string;
  refCruce: string | null;
  debito: number | null;
  credito: number | null;
  saldo: number;
}

/** Response shape for GET /consultas/auxiliar-cartera. */
export interface RespuestaAuxiliarCartera {
  inmuebleId: string;
  inmuebleCodigo: string;
  propietario: string | null;
  desde: string;
  hasta: string;
  saldoInicial: number;
  movimientos: MovimientoKardex[];
  totalDebitos: number;
  totalCreditos: number;
  saldoFinal: number;
}

/* ── Vencimientos de Cartera (aging report) ───────────────────── */

/**
 * One aging bucket. Fixed, universal set (never a per-coproperty catalog
 * like ConceptoCobro) — this is the one place columns-per-bucket is fine,
 * unlike concepts, which are always rows (see ConceptoCobro's own schema
 * comment).
 */
export type RangoVencimiento =
  | 'sinVencer'
  | 'dias_1_30'
  | 'dias_31_60'
  | 'dias_61_90'
  | 'dias_91_120'
  | 'dias_121_180'
  | 'dias_181_360'
  | 'dias_361_720'
  | 'dias_720_mas';

/**
 * One pending Factura or Nota Débito, coproperty-wide, aged as of the
 * cut-off. Falls into exactly one `rango` — `saldo` is that document's full
 * pending amount, not split across buckets.
 */
export interface FilaVencimientoCartera {
  inmuebleId: string;
  inmuebleCodigo: string;
  propietario: string | null;
  tipo: 'FV' | 'ND';
  numeroCompleto: string;
  fecha: string;
  vence: string;
  diasMora: number;
  saldo: number;
  rango: RangoVencimiento;
}

/** One aging bucket's total across every pending document. */
export interface RangoVencimientoCartera {
  rango: RangoVencimiento;
  etiqueta: string;
  valor: number;
}

/** Response shape for GET /consultas/vencimientos-cartera. */
export interface RespuestaVencimientosCartera {
  fechaCorte: string;
  filas: FilaVencimientoCartera[];
  rangos: RangoVencimientoCartera[];
  totalCartera: number;
}

/* ── Cartera por Inmueble (single-unit snapshot) ──────────────── */

/**
 * One pending Factura or Nota Débito for one inmueble as of a cut-off date.
 * `cargosPorConcepto` keys by `conceptoId` — one entry per concept charged
 * on this specific document, so the table can lay out one column per
 * concept the coproperty uses (a concept absent from this document simply
 * has no key, read as 0 on the frontend).
 */
export interface DocumentoCarteraPorInmueble {
  tipo: 'FV' | 'ND';
  numeroCompleto: string;
  fecha: string;
  vence: string | null;
  saldo: number;
  cargosPorConcepto: Record<string, number>;
}

/**
 * One row of the per-concept breakdown. Every concept in the coproperty's
 * catalog is included, zero-balance ones too — concepts are rows here, never
 * columns (see ConceptoCobro's own schema comment on why this codebase
 * replaced the old system's fixed twelve-column design).
 */
export interface CargoCarteraPorConcepto {
  conceptoId: string;
  nombre: string;
  monto: number;
}

/** Response shape for GET /consultas/cartera-por-inmueble. */
export interface RespuestaCarteraPorInmueble {
  inmuebleId: string;
  inmuebleCodigo: string;
  propietario: string | null;
  fechaCorte: string;
  documentos: DocumentoCarteraPorInmueble[];
  cargosPorConcepto: CargoCarteraPorConcepto[];
  saldoTotalCartera: number;
}

/* ── Cartera General (§3) ──────────────────────────────────────── */

/** Balance per charge concept, always "as of now". */
export interface CarteraPorConcepto {
  conceptoId: string;
  nombre: string;
  saldo: number;
}

/** Monthly collections flow (active applications only). */
export interface RecaudoMensual {
  anio: number;
  mes: number;
  monto: number;
}

/** Response shape for GET /consultas/cartera-general. */
export interface RespuestaCarteraGeneral {
  totalCartera: number;
  totalVencido: number;
  totalPendiente: number;
  porcentajeVencido: number;
  totalCarteraMesAnterior: number | null;
  diasPromedioMora: number;
  carteraPorConcepto: CarteraPorConcepto[];
  tendenciaRecaudo: RecaudoMensual[];
}

/* ── Estado de Cuenta (§4) ──────────────────────────────────────── */

/** One billed period available for an inmueble. */
export interface PeriodoFacturado {
  periodStart: string;
  periodEnd: string;
}

/** One movement line in an owner's statement. */
export interface MovimientoEstadoCuenta {
  fecha: string;
  concepto: string;
  cargo: number | null;
  abono: number | null;
  /** `'pago'` for Recibo applications, `'descuento'` for NC, `null` for
   *  Nota Contable rows (informational only, never summed). */
  categoria: 'pago' | 'descuento' | null;
}

/** Response shape for GET /consultas/estado-cuenta. */
export interface RespuestaEstadoCuenta {
  inmuebleCodigo: string;
  propietario: string | null;
  copropiedadTelefono: string | null;
  copropiedadEmail: string | null;
  periodStart: string;
  periodEnd: string;
  fechaEmision: string;
  vencimiento: string;
  saldoAnterior: number;
  cargosDelMes: number;
  pagosRecibidos: number;
  descuentosAjustes: number;
  saldoActual: number;
  estado: 'al_dia' | 'pendiente' | 'vencido';
  movimientos: MovimientoEstadoCuenta[];
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

/** One row's outcome from a bulk upload of one-off charges that could not be processed. */
export interface ErrorCargaNovedades {
  /** 1-based, matching the row order the file was uploaded in. */
  fila: number;
  mensaje: string;
}

/**
 * Result of uploading one-off charges for a billing run. Rows are independent:
 * one bad row does not abort the rest, because a file with a few typos should
 * not have to be re-uploaded whole.
 */
export interface ResultadoCargaNovedades {
  total: number;
  cargadas: number;
  errores: ErrorCargaNovedades[];
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
  /**
   * Who `nombreAdministrador`'s own note points to: the account(s) with an
   * active Asignación scoped directly to this coproperty (`entidadAdministradora`
   * null case only — an entidad grant covers the building through the
   * company, not through a per-building Asignación row). Several names,
   * comma-joined, when more than one account is assigned. Null when nobody
   * is, same as `entidadAdministradora`.
   */
  usuarioAdministrador: string | null;
  estado: 'activo' | 'inactivo';
  /** Whether this building ALSO uses the building-management system. */
  usaGestionEdificios: boolean;
  cuentaContableCartera: string | null;
  /** Cuenta de pasivo para dinero recibido pero aún no aplicado a ningún
   *  documento — el anticipo de un Recibo de Caja. */
  cuentaAnticipos: string | null;
  /** Cuenta de gasto/contra-ingreso que se debita al emitir una nota
   *  crédito — igual razonamiento y forma que cuentaAnticipos. */
  cuentaDevoluciones: string | null;
  /** Cuenta de activo para el saldo de notas débito emitidas — contraparte
   *  de cuentaContableCartera pero específico para ND. */
  cuentaNotasDebito: string | null;
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
  cuentaDebitoId: string | null;
  cuentaDebitoCodigo: string | null;
  cuentaCreditoId: string | null;
  cuentaCreditoCodigo: string | null;
  cuentaImpuestoId: string | null;
  cuentaImpuestoCodigo: string | null;
  liquidaMora: boolean;
  cargaXls: boolean;
  sistema: boolean;
}

/**
 * What one unit is charged for one concept, every billing cycle — the
 * standing template `LotesFacturacionService.liquidar()` reads to build each
 * month's invoice lines. See the note on `ValorRecurrente`'s schema: this
 * replaces the legacy "Datos Financieros" tab's twelve fixed columns with one
 * row per concept the building actually declared.
 *
 * One entry per concept in the coproperty's catalog, `intereses` included —
 * shown so the "Valores Recurrentes" screen can list it for context, but
 * never savable as a flat amount (see `tipoConcepto` below and the note on
 * `ValoresRecurrentesService.guardar`: saving a nonzero `monto` against an
 * `intereses` concepto is rejected, because `LotesFacturacionService`
 * already computes that line from overdue balances — a saved flat amount
 * would double-charge it, once as a recurring line and once as mora).
 * `monto: 0` means no `ValorRecurrente` row exists for that pair yet —
 * never that a zero-amount row was saved. Saving `monto: 0` back deletes
 * the row rather than persisting a zero.
 */
export interface ValorRecurrente {
  conceptoId: string;
  conceptoNombre: string;
  tipoConcepto: 'administracion' | 'intereses' | 'otro';
  monto: Monto;
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
  /**
   * Scope of the caller's primary assignment — enough for the header to
   * label who is signed in, without the names/permissions `AsignacionResumen`
   * carries. Null for a platform administrator (that flag already says
   * enough) and for a person with no assignment yet.
   */
  alcance: 'copropiedad' | 'entidad' | null;
}

/* ── Consulta de Movimiento Contable (§12) ────────────────────── */

/** One debit or credit line within a journal entry card. */
export interface LineaMovimientoContable {
  cuenta: string;
  /** Resolved from the coproperty's chart of accounts by `cuenta` (code);
   *  falls back to the code itself if no matching CuentaContable exists. */
  nombreCuenta: string;
  tipo: 'debito' | 'credito';
  monto: number;
  descripcion: string;
  /** The inmueble's unit code — present only when this line's account
   *  requires a tercero. */
  tercero: string | null;
  /** The coproperty's cost centre — present only when this line's account
   *  requires one. */
  centroCosto: string | null;
  /** The coproperty's cash-flow code — present only when this line's
   *  account is flagged for cash-flow reporting. */
  flujoCaja: string | null;
  /** The taxable base this line's tax was computed from — present only on
   *  the tax-credit line a taxed Cargo splits out. */
  baseGravable: number | null;
}

/** One journal entry card in the accounting journal view. */
export interface MovimientoContable {
  id: string;
  fecha: string;
  tipoDocumento: 'FC' | 'RC' | 'NC' | 'ND' | 'NT' | 'NA';
  /** The anchor document's own _id — links to its detail page. */
  documentoId: string;
  numeroDocumento: string;
  inmuebleCodigo: string | null;
  propietario: string | null;
  nit: string | null;
  lineas: LineaMovimientoContable[];
  totalDebito: number;
  totalCredito: number;
  cuadra: boolean;
}

/** Response shape for both GET /consultas/movimiento-contable endpoints. */
export interface RespuestaMovimientoContable {
  movimientos: MovimientoContable[];
}

/* ── Panel de Control / Auditoría (§13) ──────────────────────── */

/** A single audit log entry — the API shape, not the persistence model. */
export interface RegistroAuditoriaContract {
  id: string;
  actorNombre: string;
  accion: 'crear' | 'actualizar';
  entidadTipo: 'entidad-administradora' | 'copropiedad' | 'usuario';
  entidadEtiqueta: string;
  /** ISO 8601 — mirrors the document's createdAt. */
  fecha: string;
}

/** Dashboard KPIs for the super-admin panel. */
export interface ResumenPanelControl {
  totalEntidades: number;
  totalCopropiedadesActivas: number;
  totalUsuariosActivos: number;
}

/* ── Configuración: Maestro de Cuentas Contables ─────────────── */

export interface CuentaContableContract {
  id: string;
  codigo: string;
  nombre: string;
  requiereTercero: boolean;
  esBanco: boolean;
  flujoCaja: boolean;
  centroUtilidad: boolean;
  centroDestino: boolean;
  requiereDocumentoCruce: boolean;
  aplicaImpuesto: boolean;
  tasaImpuesto: number;
  activo: boolean;
}

/** One row of a bulk cuentas-contables import that failed — same shape as
 *  `ErrorImportacionInmueble`, kept separate so each import endpoint's
 *  contract can evolve independently. */
export interface ErrorImportacionCuenta {
  /** 1-based, matching the row order the file was uploaded in. */
  fila: number;
  codigo: string | null;
  mensaje: string;
}

export interface ResultadoImportacionCuentas {
  total: number;
  creados: number;
  errores: ErrorImportacionCuenta[];
}

/* ── Configuración: Tabla de Documentos ──────────────────────── */

export interface DocumentoAdmin {
  categoria: 'FV' | 'IN' | 'NC' | 'ND' | 'NT';
  codigo: string;
  nombreDocumento: string | null;
  prefijo: string;
  numero: number;
  numeroE: number | null;
  comprob: string | null;
}

export interface ResolucionAdmin {
  id: string;
  numeroResolucion: string;
  prefijo: string;
  rangoDesde: number;
  rangoHasta: number;
  numeroSiguiente: number;
  vigenciaDesde: string;
  vigenciaHasta: string | null;
  estado: 'activa' | 'inactiva';
  nombreDocumento: string | null;
  comprob: string | null;
  numeroE: number | null;
}

/* ── Catálogos DIAN/DANE (solo lectura) ──────────────────────────
 *
 * Ya nacen en español porque no hay documento inglés detrás que traducir —
 * ver la nota en `catalogos.data.ts`. La API los reexporta tal cual.
 */

export interface TipoIdentificacionDian {
  codigo: string;
  nombre: string;
}

export interface DepartamentoDian {
  codigo: string;
  nombre: string;
}

export interface CiudadDian {
  codigo: string;
  nombre: string;
  departamentoCodigo: string;
}

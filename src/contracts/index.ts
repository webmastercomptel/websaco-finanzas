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

/* ── Plantillas de Documento ───────────────────────────────────── */

/**
 * One platform-wide pdfmake template — the `docDefinition` JSON (with
 * `{{nombre}}`-style placeholders) the frontend fills in and renders for a
 * given document type. `docDefinition` is intentionally `Record<string,
 * unknown>` here rather than a typed pdfmake shape: this backend never reads
 * or validates its internals, only stores and returns it opaquely — see
 * `PlantillaDocumento` (schema) for the full reasoning.
 */
export interface PlantillaDocumento {
  tipoDocumento: 'FV' | 'RC' | 'NC' | 'ND' | 'NA' | 'NT';
  docDefinition: Record<string, unknown>;
  fechaActualizacion: IsoDate;
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
  /** Free-text cross-reference to an external record — e.g. a cadastral id
   *  or the building-management system's own id for this unit, when there
   *  is one. Never used to look anything up internally. */
  referencia: string | null;
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
  estadoCartera: 'vigente' | 'juridico' | 'dificil_recaudo';
  /**
   * Whether this unit is billed going forward — `LotesFacturacionService`
   * only ever queries `inactivo` units OUT of a new cycle's preview
   * (product decision, 2026-09-21); a unit already billed keeps every past
   * Factura untouched, same as every other retire-not-delete state in this
   * domain. Not the same axis as `estadoCartera` (collections follow-up on
   * an ACTIVE unit) or `SaldoInicial`/delete (this unit never existed in
   * this system at all).
   */
  estado: 'activo' | 'inactivo';
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

/** One column of the coproperty-wide "Listado de Inmuebles" roster — one
 *  recurring charge concept in the catalog. `intereses` is never included:
 *  it is computed from overdue balances, never a flat recurring amount. */
export interface ConceptoListadoInmuebles {
  conceptoId: string;
  nombre: string;
}

/** One unit's row in the roster — its recurring cargo amounts keyed by
 *  `conceptoId`, same "absent key reads as 0" convention as
 *  `DocumentoCarteraPorInmueble.cargosPorConcepto`. */
export interface ItemListadoInmuebles {
  codigo: string;
  titular: string | null;
  area: number | null;
  coeficiente: number | null;
  valores: Record<string, Monto>;
}

/** Response shape for GET /inmuebles/listado — the same roster
 *  `GET /inmuebles/listado.pdf` prints, as JSON: what the frontend's Excel
 *  export button builds its workbook from. */
export interface RespuestaListadoInmuebles {
  copropiedadCodigo: string;
  conceptos: ConceptoListadoInmuebles[];
  items: ItemListadoInmuebles[];
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
  /** See the note on `Tercero.emails` (schema) — more than one inbox for
   *  the same party, never null, empty when none is on file. */
  emails: string[];
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
  /** How much of THIS line is still pending today — unlike
   *  saldoAnterior/nuevoSaldo above, this is live, not a frozen snapshot.
   *  What a Recibo's manual per-concepto distribution is validated and
   *  capped against. */
  saldoPendiente: Monto;
}

/** One row of the "Cargos del Mes" table inside `DatosPlantillaFactura` —
 *  one concept's saldo anterior / cargos del mes / nuevo saldo, mirroring
 *  the old react-pdf `CuerpoFactura`'s own row shape now that rendering
 *  moved to the frontend (pdfmake). */
export interface CargoPlantillaFactura {
  nombre: string;
  saldoAnterior: Monto;
  cargosDelMes: Monto;
  nuevoSaldo: Monto;
}

/**
 * Computed totals a Factura/Prefactura's pdfmake template needs beyond its
 * own frozen/previewed fields — relocated from the old react-pdf
 * `contenidoDocumentoFacturacion` (see `FacturasService.datosPlantilla`/
 * `datosPlantillaPreliminar`). For a Factura this travels once, in the same
 * response as `solicitar-generacion` — never re-derived on every `findOne`.
 * For a Prefactura (no issuance moment to freeze at) it is computed fresh on
 * every read, same as the rest of `DocumentoPrefactura`.
 */
export interface DatosPlantillaFactura {
  cargos: CargoPlantillaFactura[];
  totalSaldoAnterior: Monto;
  totalCargosDelMes: Monto;
  totalNuevoSaldo: Monto;
  totalIva: Monto;
  etiquetaIva: string;
  totalAPagar: Monto;
  /** `totalAPagar` menos el descuento por pronto pago y el anticipo
   *  disponible — `null` cuando el documento no ofrece descuento. */
  totalConDescuento: Monto | null;
  referenciaPago: string | null;
  totalAnticipos: Monto;
  notas: string | null;
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
  /** Early-payment discount this invoice offers — 0 when it has none (mora,
   *  or nothing configured on the lote). See `Factura.discountAmount`. */
  montoDescuento: Monto;
  /** Last date a Recibo still earns `montoDescuento` — null exactly when
   *  `montoDescuento` is 0. */
  fechaLimiteDescuento: IsoDate | null;
  estado: 'emitida' | 'anulada';
  motivoAnulacion: MotivoAnulacionFactura | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
}

/** One entry of `GET /lotes/:id/facturas/documentos` — a plain listing of a
 *  lote's invoices (id + unit code). There is no per-invoice presentation
 *  pointer any more: a lote's invoice run produces ONE combined PDF (one
 *  page per invoice, anchored on the Lote's own id), read via
 *  `GET /lotes/:id/url-lectura` — see `SolicitudGeneracionFacturaLote`. */
export interface DocumentoFacturaLote {
  id: string;
  inmuebleCodigo: string;
}

/** Response of `GET /lotes/:id/inmuebles/:inmuebleId/prefactura/documento`
 *  — a Prefactura has no issuance moment to freeze at, so this is computed
 *  fresh on every request instead of read from a stored field: the current
 *  template (`plantilla_documento` row for `FV`) plus this unit's computed
 *  totals. No `objectPath`/`generatedAt` — a Prefactura never gets a
 *  `presentacion_documento` row, since it is never issued. */
export interface DocumentoPrefactura {
  plantilla: PlantillaDocumento;
  datos: DatosPlantillaFactura;
}

/** Response of `GET /facturas/:id/documento` — a live-computed view of one
 *  already-issued Factura's PDF content: the current template
 *  (`plantilla_documento` row for `FV`) plus this invoice's own computed
 *  totals (`FacturasService.datosPlantilla`), recomputed on every call —
 *  never read from a stored file. The lote's invoice run produces ONE
 *  combined PDF for the whole batch (see `SolicitudGeneracionFacturaLote`/
 *  `LotesController`'s `:id/url-lectura`); reading that file to show a
 *  single invoice would leak every other unit's invoice to whoever is only
 *  entitled to see their own, so this route computes it live instead, same
 *  as `DocumentoPrefactura` above (same shape, on purpose). */
export interface DocumentoFactura {
  plantilla: PlantillaDocumento;
  datos: DatosPlantillaFactura;
}

/** One entry of `GET /lotes/:id/prefacturas/documentos` — same idea as
 *  `DocumentoFacturaLote`, but always computed live: a Prefactura reflects
 *  the lote's current previsualización, edits included, never cached. */
export interface DocumentoPrefacturaLote {
  inmuebleId: string;
  inmuebleCodigo: string;
  datos: DatosPlantillaFactura;
}

/** Response of `POST /lotes/:id/facturas/solicitar-generacion` — a lote's
 *  invoice run produces ONE combined PDF (one page per invoice), so this is
 *  anchored on the LOTE's own id, not any one Factura's: `objectPath`/
 *  `uploadUrl`/`expiresAt` are the single upload target the frontend renders
 *  that combined file to (hoisted to the top level, unlike the old
 *  per-invoice shape this replaced). `facturas` is just each invoice's own
 *  computed `datos` — one page's worth, in the order the combined PDF must
 *  render them. See `FacturasService.datosPlantilla`. */
export interface SolicitudGeneracionFacturaLote {
  plantilla: PlantillaDocumento;
  objectPath: string;
  uploadUrl: string;
  expiresAt: IsoDate;
  facturas: {
    facturaId: string;
    datos: DatosPlantillaFactura;
  }[];
}

/** Why a Factura was voided — same catalog as a Nota Crédito's void (no
 *  domain-specific list was requested for this document either). Voiding a
 *  Factura always creates a Nota Crédito behind the scenes (see
 *  `AnularFacturaService`) — this is the Factura's OWN void reason, distinct
 *  from that note's `motivo` (always `'anulacion_factura'` for this path). */
export type MotivoAnulacionFactura =
  | 'error_digitacion'
  | 'error_facturacion'
  | 'duplicado'
  | 'ajuste_contrato'
  | 'otro';

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
  /** Mutually exclusive with `descuentoProntoPago` in practice — only used
   *  when the percentage is 0. See Parámetros de Facturación §4's rule. */
  valorFijoDescuentoProntoPago: number;
  diasGraciaDescuento: number;
  interesMora: number;
  /** Not a ceiling on the mora amount — the minimum overdue balance before
   *  mora is calculated at all. See the note on `lateInterestCap` in
   *  lote-facturacion.schema.ts. */
  topeInteresMora: number | null;
  fechaLimiteDescuento: IsoDate;
  fechaSuspension: IsoDate;
  /** Set only for a "Factura Individual" — a one-off, single-unit lote
   *  created outside the normal monthly cycle, always pinned to the current
   *  period. `null` for an ordinary whole-coproperty lote. See
   *  `LotesFacturacionService.crearIndividual`. */
  inmuebleId: string | null;
  totalNovedades: number;
  totalPrevisualizacion: number;
  resumen: {
    montoTotal: Monto;
    totalFacturas: number;
    totalInmuebles: number;
    tipoDocumento: 'FV';
    /** Número completo (prefijo + consecutivo) de la primera y la última
     *  factura emitidas en este lote — `null` en un lote consolidado antes
     *  de que este campo existiera. */
    primerNumero: string | null;
    ultimoNumero: string | null;
  } | null;
  /** Set while consolidar() is running this lote, null otherwise — lets the
   *  frontend poll and show "fila X de Y" instead of a frozen button. */
  progreso: { actual: number; total: number } | null;
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
 * Result of wiping every financial document (Lotes/Facturas, Recibos, Notas
 * Crédito/Débito/Anticipo/Contables, Saldos Iniciales, and their derived
 * asientos/saldos) of the one hardcoded test coproperty, so its billing
 * cycle can be replayed from a blank slate. See `ReiniciarCicloService` for
 * the safety checks.
 */
export interface ResultadoReinicioCiclo {
  lotesEliminados: number;
  facturasEliminadas: number;
  recibosEliminados: number;
  loteRecibosEliminados: number;
  notasCreditoEliminadas: number;
  notasDebitoEliminadas: number;
  notasAnticipoEliminadas: number;
  notasContablesEliminadas: number;
  aplicacionesEliminadas: number;
  asientosEliminados: number;
  saldosEliminados: number;
  carteraPorDocumentoEliminada: number;
  saldosDocumentoOrigenEliminados: number;
  lotesContabilidadEliminados: number;
  saldosInicialesEliminados: number;
  lotesSaldoInicialEliminados: number;
  saldoTotalDocumentoEliminado: number;
  saldosInicialesAnticipoEliminados: number;
  lotesSaldoInicialAnticipoEliminados: number;
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
  /** The Factura's own id — lets the on-screen table link to `/facturas/:id`
   *  ("Ver"), the same way the Facturas list itself does. */
  id: string;
  inmuebleId: string;
  inmuebleCodigo: string;
  tipoDocumento: 'FV';
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  fechaFactura: IsoDate;
  fechaVence: IsoDate;
  titular: TitularFactura | null;
  valoresPorConcepto: Record<string, Monto>;
  valoresIvaPorConcepto: Record<string, Monto>;
  subtotal: Monto;
  totalImpuestos: Monto;
  total: Monto;
  /** Live balance, same `SaldoTotalDocumento`-sourced figure the Facturas
   *  list itself shows — never a frozen field on the Factura. */
  saldoPendiente: Monto;
  estado: 'emitida' | 'anulada';
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
  inmuebleCodigo: string;
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
  /** Portion of a payment SURPLUS the user sent to Otros Ingresos instead
   *  of Anticipos (`destinoSobrante: 'otros_ingresos'`), manual mode only —
   *  0 in every other case. Distinct from `montoAplicado`: this money never
   *  touched cartera, so it can't be folded into it (see `RecibosService`'s
   *  own note on the bug this field fixes). */
  montoOtrosIngresos: Monto;
  estado: 'activo' | 'anulado';
  motivoAnulacion: MotivoAnulacionRecibo | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
  /** Set by `solicitarGeneracion` (pending upload) and confirmed by
   *  `confirmarGeneracion` — see `PresentacionDocumento`'s own docblock for
   *  the two-phase write this mirrors. Unlike Factura (batch-only, one
   *  combined PDF per lote — see `SolicitudGeneracionFacturaLote`), a Recibo
   *  is issued and stored one-to-one, so it keeps its own pointer here. */
  objectPath: string | null;
  generatedAt: IsoDate | null;
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
  tipoDocumento: 'FV' | 'ND' | 'SI';
  documentoId: string;
  /** The target document's own printed number (e.g. "FV-1") — resolved for
   *  display, never stored on this row itself. `null` when the document
   *  can no longer be resolved (in practice never expected, since financial
   *  documents are never deleted). */
  numeroDocumento: string | null;
  montoAplicado: Monto;
  /** Portion of `montoAplicado` that is early-payment discount, not real
   *  money — 0 in the normal case. See `AplicacionCartera.discountApplied`. */
  montoDescuento: Monto;
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

/** One entry of `GET /lotes-recibos/:id/documentos` — a batch's receipts,
 *  each with its own presentation pointer. See `Recibo.objectPath`/
 *  `generatedAt`. Unlike `DocumentoFacturaLote` (Factura moved to one
 *  combined PDF per lote), a Recibo is still stored one-to-one, so this
 *  keeps the per-row pointer. */
export interface DocumentoReciboLote {
  id: string;
  inmuebleCodigo: string;
  objectPath: string | null;
  generatedAt: IsoDate | null;
}

/** One row of a Recibos-por-lote upload. */
export interface LoteRecibosFila {
  inmuebleCodigo: string;
  /** The código de copropiedad the file's own row carried, if any — a pure
   *  cross-check display value, never what resolves the tenant. */
  copropiedadCodigo: string | null;
  inmuebleId: string | null;
  fechaPago: IsoDate;
  valorRecibido: Monto;
  reciboId: string | null;
  /** Resolved for display once this row becomes a real Recibo. */
  reciboNumeroCompleto: string | null;
  error: string | null;
}

/**
 * A batch of Recibos de Caja uploaded from a flat file — `borrador`
 * (created, nothing uploaded yet) → `cargado` (file parsed, rows validated,
 * waiting for the totalDigitado check to pass) → `aplicado` (every row
 * without an error became its own real Recibo). See `LoteRecibosService`.
 */
export interface LoteRecibos {
  id: string;
  numero: number;
  estado: 'borrador' | 'cargado' | 'aplicado';
  /** When this batch was created — a domain field the service sets
   *  explicitly, not Mongo's own `timestamps` bookkeeping. */
  creadoEn: IsoDate;
  codigo: string;
  medioPago: 'transferencia' | 'cheque' | 'pse' | 'efectivo';
  cuentaDestino: string | null;
  totalDigitado: Monto;
  /** Sum of `valorRecibido` across every row WITHOUT an error — what the
   *  frontend compares against `totalDigitado` to enable "Actualizar
   *  Cartera". */
  totalFilas: Monto;
  filas: LoteRecibosFila[];
}

/** One row's outcome from `aplicar()`ing a LoteRecibos — mirrors
 *  `ErrorConsolidacion`'s own "best-effort, report per row" shape. */
export interface ErrorAplicacionLoteRecibos {
  fila: number;
  inmuebleCodigo: string;
  mensaje: string;
}

/** One line of `aplicaciones` in `CrearReciboDto`/`AplicarReciboDto` — the
 *  caller's requested cruce against one document. */
export interface AplicacionSolicitada {
  tipoDocumento: 'FV' | 'ND' | 'SI';
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

/** Why a Nota Crédito was issued — DIAN's own "Concepto de Corrección para
 *  Notas crédito" catalog (Anexo 1.8-2021 §13.3.4), not this app's own
 *  invention. See the schema's own docblock (`nota-credito.schema.ts`) for
 *  the full citation and the code-1-through-5 ordering these mirror.
 *  `anulacion_factura` ("Anulación de factura electrónica") is valid ONLY
 *  when `NotaCredito.tipoDocumentoAncla === 'FV'` — it names the dedicated
 *  `anularFactura()` flow, which has no Nota Débito equivalent
 *  (`NotasDebitoService.anular()` already covers a full void). Rejected
 *  server-side (`NotasCreditoService.crear()`) against a `'ND'` anchor. */
export type MotivoNotaCredito =
  | 'devolucion_parcial'
  | 'anulacion_factura'
  | 'descuento'
  | 'ajuste_precio'
  | 'otro';

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
 * A credit note ("NC"), always issued against exactly one anchor document —
 * a Factura OR a Nota Débito (unlike `Recibo`, design §3.2, which never
 * requires one). `montoAplicado`/`montoSinAplicar` are the only fields that
 * move after creation, same pattern as `Recibo`.
 */
export interface NotaCredito {
  id: string;
  inmuebleId: string;
  inmuebleCodigo: string;
  terceroId: string | null;
  /** Which kind of document `documentoAnclaId` points to. */
  tipoDocumentoAncla: 'FV' | 'ND' | 'SI';
  /** The anchor document's own id — a Factura's or a Nota Débito's,
   *  according to `tipoDocumentoAncla`. */
  documentoAnclaId: string;
  /** The anchor document's own printed number ("FV-1"/"ND-1") — `null` on
   *  the lean listing (`GET /notas-credito`), which never resolves it;
   *  always set on the detail view (`GET /notas-credito/:id`). */
  numeroDocumentoAncla: string | null;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  /** The date the user declared for this note at creation, validated then
   *  against the coproperty's current billing period — see
   *  `NotaCredito.issueDate` (schema). Falls back to the document's own
   *  `createdAt` for notes created before this field existed. */
  fecha: IsoDate;
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
  /** Set by `solicitarGeneracion` (pending upload) and confirmed by
   *  `confirmarGeneracion` — see `Recibo.objectPath`/`generatedAt` for the
   *  shared two-phase write this mirrors. Unlike the old `documentDefinition`
   *  (which `aplicar()` re-froze every time it ran), this is never
   *  re-requested once confirmed: nothing re-renders after issuance under
   *  the new model. */
  objectPath: string | null;
  generatedAt: IsoDate | null;
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

/** Why a Nota Débito was issued — DIAN's own "Concepto de Corrección para
 *  Notas débito" catalog (Anexo 1.8-2021 §13.2.5), not this app's own
 *  invention. See the schema's own docblock (`nota-debito.schema.ts`) for
 *  the full citation and the code-1-through-4 ordering these mirror. */
export type MotivoNotaDebito =
  'intereses' | 'gastos_por_cobrar' | 'cambio_valor' | 'otro';

/** A debit note ("ND"), always issued against a concepto for an inmueble —
 *  used to charge amounts that are not part of a regular invoice (design §2). */
export interface NotaDebito {
  id: string;
  inmuebleId: string;
  inmuebleCodigo: string;
  terceroId: string | null;
  conceptoId: string;
  motivo: MotivoNotaDebito;
  descripcion: string | null;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  fechaEmision: IsoDate;
  fechaVencimiento: IsoDate;
  total: Monto;
  saldoPendiente: Monto;
  estado: 'emitida' | 'anulada';
  motivoAnulacion: MotivoAnulacionNotaCredito | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
  /** Set by `solicitarGeneracion` (pending upload) and confirmed by
   *  `confirmarGeneracion` — see `Recibo.objectPath`/`generatedAt`. */
  objectPath: string | null;
  generatedAt: IsoDate | null;
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
 * A "Nota de Anticipo" ("NA") — applies a leftover `montoSinAplicar` against
 * open cartera LATER, as its own auditable document, from the Anticipos
 * module (never from the origin document itself — see `Recibo`'s own note
 * on why there is no `/recibos/:id/aplicar`). `origenTipo` says which
 * collection `reciboOrigenId` points into: `'RC'` a real Recibo, or `'SI'`
 * an opening anticipo balance imported from the client's previous system
 * (`SaldoInicialAnticipo`).
 */
export interface NotaAnticipo {
  id: string;
  inmuebleId: string;
  inmuebleCodigo: string;
  terceroId: string | null;
  origenTipo: 'RC' | 'SI';
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
  /** Set by `solicitarGeneracion` (pending upload) and confirmed by
   *  `confirmarGeneracion` — see `Recibo.objectPath`/`generatedAt`. */
  objectPath: string | null;
  generatedAt: IsoDate | null;
}

/**
 * `NotaAnticipo` plus the cargo-por-cargo breakdown of what it applied —
 * what `GET /notas-anticipo/:id` returns, same pattern as
 * `NotaDebitoDetalle`.
 */
export interface NotaAnticipoDetalle extends NotaAnticipo {
  aplicaciones: AplicacionCartera[];
}

/* ── Saldos Iniciales (opening cartera balances) ──────────────── */

/** One cargo (concepto) line of a Saldo Inicial's own breakdown. */
export interface SaldoInicialLinea {
  conceptoId: string;
  nombreConcepto: string;
  monto: Monto;
}

/** Why a Saldo Inicial was voided — a narrower catalog than the other
 *  documents' (design consistency): an opening balance is only ever loaded
 *  once, right when a coproperty is onboarded, so the realistic reasons to
 *  undo one are a typo or a duplicate upload. */
export type MotivoAnulacionSaldoInicial =
  'error_digitacion' | 'duplicado' | 'otro';

/**
 * A THIRD cartera charge document, alongside Factura and Nota Débito — one
 * opening balance brought from the client's previous system, aged and
 * collectible exactly like a Factura, but never consuming its numbering.
 * `tipoDocumentoOriginal`/`numeroOriginal` are free text the client typed;
 * `saldoPendiente` is what a future Recibo/Nota Crédito can still collect.
 */
export interface SaldoInicial {
  id: string;
  inmuebleId: string;
  inmuebleCodigo: string;
  tipoDocumentoOriginal: string;
  numeroOriginal: string;
  fecha: IsoDate;
  fechaVencimiento: IsoDate;
  lineas: SaldoInicialLinea[];
  total: Monto;
  saldoPendiente: Monto;
  estado: 'activo' | 'anulado';
  motivoAnulacion: MotivoAnulacionSaldoInicial | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
}

/** One row of a bulk Saldos Iniciales import that could not be applied. */
export interface ErrorImportacionSaldoInicial {
  /** 1-based, matching the row order the file was uploaded in. */
  fila: number;
  inmuebleCodigo: string | null;
  mensaje: string;
}

/**
 * Result of importing a Saldos Iniciales file — rows are independent, one
 * bad row (an unknown código de copropiedad or inmueble, a total that
 * doesn't match its own cargos) never aborts the rest. Mirrors
 * `ResultadoImportacionValoresRecurrentes`'s own shape.
 */
export interface ResultadoImportacionSaldosIniciales {
  total: number;
  importados: number;
  errores: ErrorImportacionSaldoInicial[];
}

/* ── Saldos Iniciales de Anticipo (opening credit balances) ───── */

/** Same narrow catalog as `MotivoAnulacionSaldoInicial`, same reasoning: an
 *  opening anticipo balance is only ever loaded once, at onboarding. */
export type MotivoAnulacionSaldoInicialAnticipo =
  'error_digitacion' | 'duplicado' | 'otro';

/**
 * An opening ANTICIPO (credit) balance brought from the client's previous
 * system — a unit had already paid ahead, and `saldoDisponible` is what a
 * future Nota de Anticipo can still draw down against open cartera. Never a
 * synthetic Recibo (see `SaldoInicialAnticipo`'s own schema docblock) —
 * `tipoDocumentoOriginal`/`numeroOriginal` are the free text the client
 * typed for their own previous receipt (typically `'RC'` and its number).
 */
export interface SaldoInicialAnticipo {
  id: string;
  inmuebleId: string;
  inmuebleCodigo: string;
  tipoDocumentoOriginal: string;
  numeroOriginal: string;
  fecha: IsoDate;
  monto: Monto;
  saldoDisponible: Monto;
  estado: 'activo' | 'anulado';
  motivoAnulacion: MotivoAnulacionSaldoInicialAnticipo | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
}

/**
 * Result of importing a Saldos Iniciales de Anticipo file — same
 * independent-rows behavior as `ResultadoImportacionSaldosIniciales`.
 */
export interface ResultadoImportacionSaldosInicialesAnticipo {
  total: number;
  importados: number;
  errores: ErrorImportacionSaldoInicial[];
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
  inmuebleCodigo: string;
  /** The specific Factura/NotaDebito this reclassification's per-document
   *  cartera effect landed on. Null on a note created before this field
   *  existed. */
  tipoDocumento: 'FV' | 'ND' | null;
  documentoId: string | null;
  conceptoOrigenId: string;
  conceptoDestinoId: string;
  fecha: IsoDate;
  monto: Monto;
  descripcion: string;
  prefijo: string;
  numero: number;
  numeroCompleto: string;
  estado: 'activo' | 'anulado';
  motivoAnulacion: MotivoAnulacionNotaCredito | null;
  detalleAnulacion: string | null;
  fechaAnulacion: IsoDate | null;
  /** Set by `solicitarGeneracion` (pending upload) and confirmed by
   *  `confirmarGeneracion` — see `Recibo.objectPath`/`generatedAt`. */
  objectPath: string | null;
  generatedAt: IsoDate | null;
}

/* ── Auxiliar de Cartera (kardex) ────────────────────────────── */

/** `'SI'` rows carry the client's own original code (e.g. "FV", "ND") from
 *  their previous system instead of the literal `'SI'` — see
 *  `SaldoInicial.tipoDocumentoOriginal`'s own schema docblock. The
 *  `(string & {})` member keeps autocomplete on the six real system codes
 *  while still accepting that free text. */
export type TipoDocumentoKardex =
  'FC' | 'RC' | 'NC' | 'ND' | 'NT' | 'NA' | 'SI' | (string & {});

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
  /** A Saldo Inicial row carries its own original code (e.g. "FV", "ND")
   *  here instead of the literal "SI" — see `TipoDocumentoKardex`'s own
   *  comment. */
  tipo: 'FV' | 'ND' | 'SI' | (string & {});
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
  /** This document's own `_id` — what a Nota Contable's `documentoId` must
   *  reference to reclassify against it specifically. */
  documentoId: string;
  /** A Saldo Inicial row carries its own original code (e.g. "FV", "ND")
   *  here instead of the literal "SI" — see `TipoDocumentoKardex`'s own
   *  comment. */
  tipo: 'FV' | 'ND' | 'SI' | (string & {});
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

/* ── Cartera por Conceptos (coproperty-wide, grouped by inmueble) ── */

/** One column of the report — one charge concept in the coproperty's
 *  catalog. */
export interface ConceptoColumnaCarteraPorConceptos {
  conceptoId: string;
  nombre: string;
}

/** One pending Factura or Nota Débito for one inmueble, always "right now"
 *  — no historical `fecha`, unlike its per-unit sibling
 *  `DocumentoCarteraPorInmueble`. `cargosPorConcepto` keys by `conceptoId`,
 *  same convention: a concept absent from this document simply has no key,
 *  read as 0 on the frontend. */
export interface DocumentoCarteraPorConceptos {
  documentoId: string;
  /** A Saldo Inicial row carries its own original code (e.g. "FV", "ND")
   *  here instead of the literal "SI" — see `TipoDocumentoKardex`'s own
   *  comment. */
  tipo: 'FV' | 'ND' | 'SI' | (string & {});
  numeroCompleto: string;
  fecha: string;
  vence: string | null;
  saldo: number;
  cargosPorConcepto: Record<string, number>;
}

/** One inmueble's pending documents, sorted by fecha ascending (then tipo,
 *  then número as tie-breakers) — the table's grouping row. */
export interface GrupoInmuebleCarteraPorConceptos {
  inmuebleId: string;
  inmuebleCodigo: string;
  titular: string | null;
  celular: string | null;
  /** The inmueble's own collection status — 'vigente' reads as "Vigente" on
   *  screen, the label used everywhere the enum value isn't shown raw. */
  estadoCartera: 'vigente' | 'juridico' | 'dificil_recaudo';
  documentos: DocumentoCarteraPorConceptos[];
  saldoTotal: number;
}

/** Response shape for GET /consultas/cartera-por-conceptos. */
export interface RespuestaCarteraPorConceptos {
  conceptos: ConceptoColumnaCarteraPorConceptos[];
  grupos: GrupoInmuebleCarteraPorConceptos[];
}

/* ── Consecutivos (one document type, sequential, one period) ─── */

/** One column of the report — one charge concept referenced by at least one
 *  row, in the coproperty's own catalog order. */
export interface ConceptoColumnaConsecutivos {
  conceptoId: string;
  nombre: string;
}

/** One document of the chosen type ("código" from the Tabla de Documentos),
 *  issued within the period. `cargosPorConcepto` keys by `conceptoId` — a
 *  concept this specific document never touched simply has no key, read as
 *  0 on the frontend. For a Nota Contable (a pure reclassification) the
 *  origen concepto carries a NEGATIVE value and the destino a positive one,
 *  netting to zero — the honest picture of "moved from X to Y", not a new
 *  charge. */
export interface FilaConsecutivo {
  documentoId: string;
  tipoDocumento: string;
  numeroCompleto: string;
  inmuebleCodigo: string;
  fecha: string;
  valorTotal: number;
  cargosPorConcepto: Record<string, number>;
}

/** Response shape for GET /consultas/consecutivos. */
export interface RespuestaConsecutivos {
  conceptos: ConceptoColumnaConsecutivos[];
  filas: FilaConsecutivo[];
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
  /** Already carries its own type prefix (e.g. "FV-0012", "RC-001-001") —
   *  no separate "Tipo Doc." column needed alongside it. */
  numeroCompleto: string;
  /** The document's own type name (e.g. "Factura de Venta", "Recibo") —
   *  never repeats `numeroCompleto`. */
  concepto: string;
  cargo: number | null;
  abono: number | null;
  /** `'pago'` for Recibo/Nota de Anticipo applications, `'descuento'` for
   *  NC, `null` for Nota Contable rows (informational only, never summed). */
  categoria: 'pago' | 'descuento' | null;
}

/** One Recibo of this inmueble still carrying a pending anticipo
 *  (`unappliedAmount > 0`) — same "pending anticipo" definition the
 *  Anticipos bandeja uses (`GET /recibos?conAnticipoDisponible=true`), here
 *  scoped to just this inmueble and shown alongside its statement. `monto`
 *  is the Recibo's LIVE `unappliedAmount`, not what it printed at creation
 *  — a later Nota de Anticipo may have already consumed part of it. */
export interface AnticipoPendienteEstadoCuenta {
  numeroCompleto: string;
  fecha: string;
  monto: number;
}

/** Response shape for GET /consultas/estado-cuenta. */
export interface RespuestaEstadoCuenta {
  inmuebleCodigo: string;
  propietario: string | null;
  copropiedadTelefono: string | null;
  copropiedadEmail: string | null;
  periodStart: string;
  periodEnd: string;
  /** Kept for `escribirMarcaDuplicado`'s own use (the "DUPLICADO" stamp
   *  shows the original emission date) — no longer rendered as its own
   *  "Fecha de emisión:" line. */
  fechaEmision: string;
  saldoAnterior: number;
  cargosDelMes: number;
  /** Monto BRUTO (`Recibo.receivedAmount`, nunca el neto aplicado de una
   *  aplicación individual) de cada Recibo ACTIVO cuya `receivedDate` cae
   *  dentro del período — una sola vez por Recibo, sin importar contra
   *  cuántas facturas se cruzó ni cuántas veces. Un Recibo recibido en el
   *  período pero aún sin ningún cruce (parqueado como anticipo) también
   *  cuenta acá. */
  pagosDelMes: number;
  /** Suma de la porción en efectivo (`amountApplied - discountApplied`) de
   *  cada cruce de Nota de Anticipo dentro del período — el reaplicar más
   *  tarde el saldo sobrante de un Recibo YA contado en un `pagosDelMes`
   *  anterior, nunca una entrada de dinero nueva este período, por eso vive
   *  separado de `pagosDelMes` en vez de sumado a él. */
  anticiposAplicados: number;
  descuentosAjustes: number;
  /** `saldoAnterior + cargosDelMes - pagosDelMes - anticiposAplicados -
   *  descuentosAjustes`. Puede quedar negativo (saldo a favor del
   *  propietario) — no se recorta acá; el PDF/pantalla lo rotulan
   *  "(A Favor)" en vez de forzarlo a cero. */
  saldoActual: number;
  /** "Vencida" cuando al menos una Factura/Nota Débito de este inmueble
   *  (sin importar el período) sigue con saldo pendiente A LA FECHA DE
   *  CORTE (`periodEnd`) y ya había pasado su propio vencimiento a esa
   *  misma fecha — no el estado de un solo documento del período
   *  consultado, que era el cálculo anterior (bug real reportado: un
   *  inmueble con cartera vencida de un mes anterior podía marcar "al día"
   *  si la factura del período consultado en particular aún no vencía). */
  estado: 'al_dia' | 'vencido';
  /** El mayor número de días de mora entre los documentos que hacen
   *  `estado` "vencido" — `null` cuando `estado` es "al_dia". Siempre
   *  calculado a `periodEnd` (la fecha de corte del propio estado de
   *  cuenta), nunca a la fecha real de hoy — ver `estado`'s docblock. */
  diasMoraMaximo: number | null;
  movimientos: MovimientoEstadoCuenta[];
  /** Anticipos pendientes por aplicar de este inmueble, sin importar el
   *  período consultado — un anticipo vivo es un saldo actual, no un
   *  movimiento de un período específico. Vacío cuando no tiene ninguno. */
  anticipos: AnticipoPendienteEstadoCuenta[];
}

/* ── Conciliación de Cartera (coproperty-wide) ──────────────────── */

/**
 * Which of the ten fixed kardex concepts a conciliación row summarizes.
 * Unlike `TipoDocumentoKardex`, a void/reversal is its own concept rather
 * than a flag on the original one — the printed reconciliation needs both
 * directions visible as separate rows, in the fixed order the format has
 * always used.
 */
export type ConceptoConciliacionCartera =
  | 'facturacion'
  | 'recibos_caja'
  | 'anulacion_recibos_caja'
  | 'notas_credito'
  | 'anulacion_notas_credito'
  | 'notas_debito'
  | 'anulacion_notas_debito'
  | 'notas_anticipo'
  | 'anulacion_notas_anticipo'
  | 'notas_contables';

/**
 * One row of the reconciliation table: one fixed concept's contribution to
 * cartera during the period, plus the first/last document number involved
 * (`desde`/`hasta`) so a mismatch can be traced back to specific documents.
 * `desde`/`hasta` are `null` when the concept had no movement in the period.
 */
export interface FilaConciliacionCartera {
  concepto: ConceptoConciliacionCartera;
  etiqueta: string;
  desde: string | null;
  hasta: string | null;
  valorDebito: number;
  valorCredito: number;
}

/** One Recibo still carrying an unapplied anticipo AS OF `periodEnd` — a
 *  historical snapshot (unlike `AnticipoPendienteEstadoCuenta`'s live-today
 *  one), matching this report's own point-in-time reasoning: what a
 *  reconciler closing out that period actually saw. */
export interface AnticipoPendienteConciliacion {
  inmuebleCodigo: string;
  fecha: string;
  numeroRecibo: string;
  valor: number;
}

/**
 * Response shape for GET /consultas/conciliacion-cartera — a coproperty-wide
 * control report, not per-inmueble (contrast Estado de Cuenta): it compares
 * a balance CALCULATED from the period's own movements — pure arithmetic,
 * `saldoAnterior + totalDebito - totalCredito` — against `saldoCarteraReal`,
 * read straight from the `SaldoCartera` table (the maintained running-balance
 * cache every other cartera screen trusts, NOT re-derived from documents).
 * `diferencia` is `saldoCarteraCalculado - saldoCarteraReal` and should read
 * 0 — anything else means the cache has drifted from the documents that are
 * supposed to maintain it (see `SaldoCartera`'s own schema docblock).
 */
export interface RespuestaConciliacionCartera {
  periodStart: string;
  periodEnd: string;
  saldoAnterior: number;
  conceptos: FilaConciliacionCartera[];
  totalDebito: number;
  totalCredito: number;
  saldoCarteraCalculado: number;
  saldoCarteraReal: number;
  diferencia: number;
  anticiposPendientes: AnticipoPendienteConciliacion[];
  /** Sum of `anticiposPendientes[].valor` — how much of `saldoCarteraReal`
   *  sits in unapplied advances as of `periodEnd`, at a glance. */
  totalAnticiposPendientes: number;
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
  /** Whether the WebSACO mark prints on this coproperty's own financial
   *  documents (Factura, Recibo, Nota Crédito/Débito/Contable/Anticipo).
   *  Default true — an opt-out, not an opt-in. */
  mostrarLogo: boolean;
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

/**
 * One unit's recurring amounts, for the coproperty-wide bulk export/import
 * screen ("Valores Recurrentes" en Inmuebles) — the per-unit `ValorRecurrente`
 * list above, keyed to the unit that owns it, `intereses` excluded (never a
 * flat amount, see the note above). `codigo` is what the file's rows are
 * matched by on import, `inmuebleId` is what the export uses to fetch each
 * unit's amounts in one shot instead of one request per unit.
 */
export interface ValorRecurrenteMasivo {
  inmuebleId: string;
  codigo: string;
  valores: { conceptoId: string; monto: Monto }[];
}

/** One row's outcome from a bulk valores-recurrentes load that could not be
 *  applied — almost always a `codigo` with no matching inmueble. */
export interface ErrorImportacionValorRecurrente {
  /** 1-based, matching the row order the file was uploaded in. */
  fila: number;
  codigo: string | null;
  mensaje: string;
}

/**
 * Result of a bulk valores-recurrentes load. Rows are independent: one bad
 * code does not abort the rest. Never creates, deletes or otherwise touches
 * an inmueble — only the `ValorRecurrente` rows of the ones it matched.
 */
export interface ResultadoImportacionValoresRecurrentes {
  total: number;
  actualizados: number;
  errores: ErrorImportacionValorRecurrente[];
}

/**
 * A coarse, throttled progress signal for a bulk import in flight — same
 * shape as `LoteFacturacion.progreso`, generalised beyond consolidar(). Null
 * means no import of that kind is currently running for the active
 * coproperty; the frontend's cue to stop polling.
 */
export interface ProgresoImportacion {
  actual: number;
  total: number;
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
  /** The FV/ND document this line settles (Recibo, Nota Crédito) or creates
   *  a receivable against (Factura, Nota Débito) — present only when this
   *  line's account is flagged `requiresCrossDocument`. */
  documentoCruce: { tipo: 'FV' | 'ND' | 'SI'; numero: number } | null;
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

/* ── Adición a Contabilidad ───────────────────────────────────── */

/** One "Adición a Contabilidad" export — see `LoteContabilidad` (backend
 *  schema) for what it records and why. */
export interface LoteContabilidad {
  id: string;
  numero: number;
  periodoDesde: IsoDate;
  periodoHasta: IsoDate;
  totalAsientos: number;
  fechaGeneracion: IsoDate;
}

/** Response shape for `POST /adicion-contabilidad/generar` — the two CSV
 *  files' full text content (small enough to embed directly; the frontend
 *  triggers the actual downloads from these strings, no second request). */
export interface RespuestaAdicionContabilidad {
  lote: LoteContabilidad;
  movmes: string;
  movmesdo: string;
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

/* ── Inicio (Copropiedad): resumen de KPIs ─────────────────────── */

/** One slice of a per-concepto pie breakdown (Facturado or Recibido). */
export interface MontoPorConcepto {
  conceptoId: string;
  nombre: string;
  monto: number;
}

/** Response shape for GET /consultas/inicio-resumen — the 3 landing-page KPI
 *  cards for a coproperty ("Total Facturado" and "Total Ingresos Recibidos";
 *  "Total de Cartera" is unchanged and sourced from `cartera-general`
 *  instead, no new field here). Both totals/breakdowns are scoped to the
 *  coproperty's own "último periodo facturado" — the `periodStart`/
 *  `periodEnd` of its most recently issued (non-anulada) Factura. */
export interface RespuestaInicioResumen {
  /** `null` when the coproperty has no Factura yet — a legitimate empty
   *  state for a brand-new coproperty, not an error. Both totals/charts
   *  below come back as `0`/`[]` in that case. */
  periodo: { periodStart: string; periodEnd: string } | null;
  totalFacturado: number;
  facturadoPorConcepto: MontoPorConcepto[];
  totalIngresosRecibidos: number;
  /** Includes a synthetic `conceptoId: 'anticipos'` entry (a sentinel that
   *  can never collide with a real Mongo ObjectId string) for the portion of
   *  received cash not yet applied to any charge — only when its `monto` is
   *  `> 0`, same "only show a slice if positive" convention
   *  `vencimientos-cartera` already uses for its rango slices. */
  recibidoPorConcepto: MontoPorConcepto[];
}

/* ── Pista de Auditoría ──────────────────────────────────────────── */

/** Fixed set of report labels — not a catalog, the 6 in-scope document
 *  types spelled out exactly as the design spec names them. */
export type TipoDocumentoPistaAuditoria =
  | 'Factura'
  | 'Recibo'
  | 'Nota Débito'
  | 'Nota Crédito'
  | 'Nota Contable'
  | 'Nota de Anticipo';

/**
 * One row per creation OR void EVENT — deliberately not one row per
 * document. A voided document produces TWO independent
 * `EventoAuditoria` rows: a `'crear'` row (`usuarioId` = the creator,
 * `fecha` = the document's own `createdAt`) and an `'anular'` row
 * (`usuarioId` = whoever voided it, `fecha` = `voidedAt`). Collapsing to
 * one row per document would make filtering by `usuarioId` ambiguous —
 * creator? voider? both? — see the design spec's "Event model" section.
 */
export interface EventoAuditoria {
  /** Genuine instant (`createdAt` for `'crear'`, `voidedAt` for
   *  `'anular'`) — format it in the viewer's own local timezone, never
   *  force UTC (opposite rule from the calendar-only business dates
   *  elsewhere in this contract, see the design spec's "Timestamp
   *  handling" section). */
  fecha: IsoDate;
  usuarioId: string;
  usuarioNombre: string;
  accion: 'crear' | 'anular';
  tipoDocumento: TipoDocumentoPistaAuditoria;
  numeroCompleto: string;
  inmuebleCodigo: string;
  valor: Monto;
  /** Link to the document's own detail page — same convention as
   *  `ActividadRecienteCopropiedad` (e.g. `/facturas/{id}`). */
  href: string;
}

/** Response shape for GET /consultas/pista-auditoria. */
export interface RespuestaPistaAuditoria {
  items: EventoAuditoria[];
  total: number;
  pagina: number;
  porPagina: number;
  /** Every distinct actor with activity in this coproperty — populates
   *  the frontend's own Usuario filter dropdown directly, without
   *  depending on `GET /usuarios` (`PlatformAdminGuard`-gated, unreachable
   *  for a regular coproperty administrator). Independent of whatever
   *  filters were applied to `items`, so the dropdown never shrinks as
   *  the user filters. */
  usuarios: { accountId: string; nombre: string }[];
}

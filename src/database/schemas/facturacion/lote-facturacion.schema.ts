import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';
import { Account } from '../cuentas/account.schema';
import { Tercero } from '../terceros/tercero.schema';
import {
  FacturaLinea,
  FacturaLineaSchema,
  TitularCongelado,
  TitularCongeladoSchema,
} from './factura-linea.schema';

export type LoteFacturacionDocument = HydratedDocument<LoteFacturacion>;

/**
 * A one-off charge for this run only — never written back into
 * ValorRecurrente, the standing monthly template. Has its own `_id` (schema
 * default, not disabled here) so a single row can be targeted individually by
 * `PATCH /lotes/:id/novedades/:novedadId` — needed once editing became
 * per-line instead of "replace the whole file".
 *
 * `sobrescribe` is null for an ordinary additive charge (the Excel/manual case
 * that always existed): it becomes its own FacturaLinea, alongside whatever
 * else the unit is charged. Set to `'recurrente'` or `'interes'`, it instead
 * REPLACES what construirPreview() would have computed from ValorRecurrente
 * or from the mora calculation for that same (inmuebleId, conceptoId) — the
 * mechanism behind "edit any line of the table, including a recurring quota
 * or the mora charge, for this run only, without touching the permanent
 * ValorRecurrente or the general mora formula".
 */
@Schema()
export class NovedadLote {
  /** Mongoose-assigned (schema default, not `_id: false`); declared here only
   *  so TypeScript knows it exists on the plain class shape. */
  _id: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: Inmueble.name, required: true })
  inmuebleId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: ConceptoCobro.name, required: true })
  conceptoId: Types.ObjectId;

  @Prop({ required: true })
  monto: number;

  @Prop({ type: String, default: null, trim: true })
  nota: string | null;

  @Prop({ type: String, enum: ['recurrente', 'interes'], default: null })
  sobrescribe: 'recurrente' | 'interes' | null;
}

export const NovedadLoteSchema = SchemaFactory.createForClass(NovedadLote);

/**
 * One unit's computed-but-not-yet-issued invoice. Everything Factura needs
 * except what only consolidación assigns: no `numero`, no `numeroCompleto`,
 * no `resolucionId`, no `saldoPendiente`, no `estado`.
 */
@Schema({ _id: false })
export class FacturaPreliminar {
  @Prop({ type: SchemaTypes.ObjectId, ref: Inmueble.name, required: true })
  inmuebleId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  codigoInmueble: string;

  @Prop({ type: SchemaTypes.ObjectId, ref: Tercero.name, default: null })
  terceroId: Types.ObjectId | null;

  @Prop({ type: TitularCongeladoSchema, default: null })
  titular: TitularCongelado | null;

  @Prop({ type: [FacturaLineaSchema], required: true, default: [] })
  lineas: FacturaLinea[];

  @Prop({ required: true })
  subtotal: number;

  @Prop({ required: true, default: 0 })
  totalImpuestos: number;

  @Prop({ required: true })
  total: number;
}

export const FacturaPreliminarSchema =
  SchemaFactory.createForClass(FacturaPreliminar);

/**
 * One billing run. Persisted, not derived, so its exact parameters (the
 * discount and mora rates, the novedades that were uploaded) stay
 * inspectable long after the run is consolidado, and so a run in progress
 * survives a page refresh. See the design doc's §3.1 for the full reasoning,
 * including why `numero` is its own atomic counter rather than reusing
 * ConsecutivoDocumento's TIPOS_DOCUMENTO.
 */
@Schema({ timestamps: true, collection: 'lotes_facturacion' })
export class LoteFacturacion {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  copropiedadId: Types.ObjectId;

  @Prop({ required: true })
  numero: number;

  @Prop({
    required: true,
    enum: ['borrador', 'liquidado', 'consolidado'],
    default: 'borrador',
  })
  estado: 'borrador' | 'liquidado' | 'consolidado';

  @Prop({ required: true })
  fechaFacturacion: Date;

  @Prop({ required: true })
  fechaVencimiento: Date;

  @Prop({ required: true })
  periodoDesde: Date;

  @Prop({ required: true })
  periodoHasta: Date;

  /**
   * Set only for a "Factura Individual" — a one-off, single-unit run created
   * outside the normal monthly cycle (`LotesFacturacionService.crearIndividual`),
   * always pinned to the CURRENT period (copied from the last `consolidado`
   * lote, never freely chosen — see that method's own docblock). `null` for
   * an ordinary whole-coproperty lote.
   *
   * Everything else about this Lote works exactly the same either way — same
   * status lifecycle, same `agregarNovedadLinea`/`liquidar`/`consolidar`
   * routes, same one-open-lote-at-a-time index. The only behavioral
   * difference lives in `construirPreview`: when this is set, the preview
   * covers ONLY this one inmueble, and skips both the ValorRecurrente
   * auto-population pass and the automatic mora calculation — every charge
   * on a Factura Individual is added by hand (product decision: this
   * sidesteps the double-charging risk of silently repeating a recurring
   * charge the next regular cycle would also produce).
   */
  @Prop({ type: SchemaTypes.ObjectId, ref: Inmueble.name, default: null })
  inmuebleId: Types.ObjectId | null;

  // Percentage form of the discount — mutually exclusive with
  // `valorFijoDescuentoProntoPago` below (Parámetros de Facturación §4's
  // own rule: a fixed value only applies when there is no percentage).
  // Applied per-invoice at `consolidar()` time, frozen onto each
  // `Factura.montoDescuento` — see that field's own comment.
  @Prop({ required: true, default: 0 })
  descuentoProntoPago: number;

  // Fixed-value form of the discount, used INSTEAD of `descuentoProntoPago`
  // when that percentage is 0 — same exclusion rule as
  // `Copropiedad.descuentoValorFijo`, which this defaults from at `crear()`
  // time (same pattern as `diasGraciaDescuento` below).
  @Prop({ required: true, default: 0 })
  valorFijoDescuentoProntoPago: number;

  @Prop({ required: true, default: 0 })
  diasGraciaDescuento: number;

  @Prop({ required: true, default: 0 })
  interesMora: number;

  /**
   * Minimum overdue balance before mora is calculated for a unit this run —
   * not a ceiling. See the note on `Copropiedad.moraValorLimite`, which
   * this defaults from at `crear()` time; a coproperty admin may override it
   * per-lote here without changing the standing parameter.
   */
  @Prop({ type: Number, default: null })
  topeInteresMora: number | null;

  /**
   * "Fecha límite para descuento" — the last date a payment still earns the
   * early-payment discount. Defaults at `crear()` time to
   * `fechaFacturacion + diasGraciaDescuento - 1 día`, editable per-lote same
   * as every other field on this screen (design note in `crear-lote.dto.ts`).
   * Frozen onto each `Factura.fechaLimiteDescuento` at `consolidar()` time —
   * see that field's own comment.
   */
  @Prop({ required: true })
  fechaLimiteDescuento: Date;

  /**
   * "Fecha de suspensión del servicio" — defaults to `periodoHasta` (the
   * last day of the billing month), editable per-lote. Not yet read
   * anywhere.
   */
  @Prop({ required: true })
  fechaSuspension: Date;

  @Prop({ type: [NovedadLoteSchema], required: true, default: [] })
  novedades: NovedadLote[];

  @Prop({ type: [FacturaPreliminarSchema], required: true, default: [] })
  previsualizacion: FacturaPreliminar[];

  @Prop({
    type: [SchemaTypes.ObjectId],
    ref: 'Factura',
    required: true,
    default: [],
  })
  facturaIds: Types.ObjectId[];

  @Prop({
    type: {
      montoTotal: { type: Number, required: true },
      totalFacturas: { type: Number, required: true },
      totalInmuebles: { type: Number, required: true },
      primerNumero: { type: String, required: true },
      ultimoNumero: { type: String, required: true },
    },
    default: null,
  })
  // `primerNumero`/`ultimoNumero` are absent on a lote consolidado before
  // this field existed — Mongoose enforces `required` only on save, never on
  // read — so the mapper falls back to `null` for those two on an old
  // document, same pattern as `fechaLimiteDescuento` above.
  resumen: {
    montoTotal: number;
    totalFacturas: number;
    totalInmuebles: number;
    primerNumero: string;
    ultimoNumero: string;
  } | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generadoPor: Types.ObjectId;

  /**
   * Set while `consolidar()` is running, cleared (`null`) the moment it
   * finishes (fully or partially) — a coarse progress signal so the
   * frontend can poll this same document and show "row 40 of 167" instead
   * of a frozen button, given a real consolidación can run tens of seconds.
   * Not itself a source of truth for anything financial; purely UI feedback.
   */
  @Prop({
    type: {
      actual: { type: Number, required: true },
      total: { type: Number, required: true },
    },
    default: null,
  })
  progreso: { actual: number; total: number } | null;

  /**
   * Owner token of the current claim (`progreso` non-null): a fresh UUID set
   * atomically with the claim by `consolidar` or `cancelar`. Every write of
   * the run (progress, heartbeat, final write, release, the delete of a
   * cancel) is conditioned on it, so a run whose claim went stale and was
   * taken over can never overwrite or release the new owner's state. Internal:
   * never exposed in the API contract. Absent/null on any lote not currently
   * claimed (and on every lote created before this field existed).
   */
  @Prop({ type: String, default: null })
  reclamoToken: string | null;
}

export const LoteFacturacionSchema =
  SchemaFactory.createForClass(LoteFacturacion);

// At most one run in flight per coproperty at a time — a second one would
// make "which lote am I liquidando" ambiguous. Explicit name required: the
// key pattern is identical to the general-purpose `copropiedadId` index
// implied by that field's own `index: true` (kept for unscoped lookups like
// findAll()'s `find({copropiedadId})`, which must also match consolidado
// rows this partial index deliberately excludes) — without distinct names,
// Mongoose auto-names both `coPropertyId_1` and MongoDB rejects the second
// with IndexOptionsConflict, silently leaving this uniqueness unenforced.
LoteFacturacionSchema.index(
  { copropiedadId: 1 },
  {
    unique: true,
    partialFilterExpression: { estado: { $in: ['borrador', 'liquidado'] } },
    name: 'unico_lote_en_curso_por_copropiedad',
  },
);

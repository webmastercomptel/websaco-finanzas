import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Account } from '../cuentas/account.schema';

export type AplicacionCarteraDocument = HydratedDocument<AplicacionCartera>;

export const SOURCE_TYPES = ['RC', 'NC', 'NA'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const DOCUMENT_TYPES = ['FV', 'ND'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * This application's own share of one concepto — frozen at application
 * time from `ajustarSaldosCartera`'s/`ajustarSaldosCarteraPorDistribucion`'s
 * own per-concepto split, the SAME numbers the accounting ledger's per-line
 * credit already uses (`RecibosService.aplicarManual`/`aplicarFifo`). Stored
 * here, not re-derived later from `AsientoContable.entries` by account code:
 * two concepts can share one account, which would make that reconstruction
 * ambiguous — this is the one place "how much of THIS payment went to THIS
 * cargo" is unambiguous and named.
 */
@Schema({ _id: false })
export class DetalleConceptoAplicacion {
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  conceptoId: Types.ObjectId;

  /** `ConceptoCobro.name`/`FacturaLinea.conceptName` at application time —
   *  frozen, same reasoning as `FacturaLinea.conceptName` itself: a later
   *  rename of the concepto must not reword history. */
  @Prop({ required: true, trim: true })
  conceptName: string;

  @Prop({ required: true })
  monto: number;
}

export const DetalleConceptoAplicacionSchema = SchemaFactory.createForClass(
  DetalleConceptoAplicacion,
);

/**
 * One cruce: one row per application of a Recibo, a Nota Crédito, or a Nota
 * de Anticipo against a document. `sourceType` discriminates which kind of
 * document made the application — the source-of-truth event log all three
 * modules share (design §3.1). A Nota de Anticipo (`'NA'`) always draws
 * against a Recibo's own `unappliedAmount` — it exists specifically for
 * applying a Recibo's leftover anticipo LATER, as its own auditable
 * document, instead of a second call mutating the Recibo directly.
 * `Factura.outstandingBalance` and `SaldoCartera.balance` are reconcilable
 * caches derived from these rows.
 *
 * GENERALIZED FROM `AplicacionRecibo` (Recibos de Caja, merged earlier this
 * session): that schema hard-coded `reciboId`, with no discriminator for the
 * source. Renamed the COLLECTION too (`aplicaciones_recibo` →
 * `aplicaciones_cartera`), not just the field — see this task's own spec for
 * why that sidesteps the `AsientoContable.facturaId` stale-index bug class
 * entirely rather than needing a `dropIndex` migration: a fresh collection
 * name means Mongoose builds fresh indexes with no old index of the same key
 * to conflict with.
 *
 * Only `'FV'` (Factura) is implemented and validated today as a target;
 * `'ND'` is reserved for when Notas Débito exists (design §2, out of scope).
 *
 * A separate collection rather than an array embedded on Recibo/NotaCredito:
 * a cruce can happen long after the source document is created (applying an
 * anticipo), and the recurring query is "every application against Factura
 * X," which an embedded array only answers via a collection-wide `$unwind`.
 */
@Schema({ timestamps: true, collection: 'aplicaciones_cartera' })
export class AplicacionCartera {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: SOURCE_TYPES })
  sourceType: SourceType;

  /** The Recibo's or NotaCredito's `_id` — which collection to look in is
   *  determined by `sourceType`, so this is a plain ObjectId, not a `ref`
   *  pointing at one fixed collection. */
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  sourceId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES })
  documentType: DocumentType;

  @Prop({ type: SchemaTypes.ObjectId, required: true })
  documentId: Types.ObjectId;

  @Prop({ required: true })
  amountApplied: number;

  /** How `amountApplied` breaks down across the target document's own
   *  conceptos — empty on documents predating this field (a Nota Débito
   *  application from before it always had exactly one concepto anyway, so
   *  the frontend falls back to a single generic row for those). */
  @Prop({ type: [DetalleConceptoAplicacionSchema], default: [] })
  detalleConceptos: DetalleConceptoAplicacion[];

  @Prop({ required: true, enum: ['activa', 'revertida'], default: 'activa' })
  status: 'activa' | 'revertida';

  @Prop({ required: true })
  appliedAt: Date;

  /** Set at the same moment `status` flips to 'revertida' — closes the
   *  "was this application active on date X?" gap for historical cartera
   *  queries (Vencimientos §8, Cartera General §2). */
  @Prop({ type: Date, default: null })
  revertedAt: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  appliedBy: Types.ObjectId;
}

export const AplicacionCarteraSchema =
  SchemaFactory.createForClass(AplicacionCartera);

// Every application against a given document — the future Auxiliar de
// Cartera screen's query (design §3.1), unchanged in shape from before.
AplicacionCarteraSchema.index({ documentType: 1, documentId: 1 });
// Every application a given Recibo OR Nota Crédito made — the void-cascade
// query. Replaces the old `{ reciboId: 1 }` index (see class docblock).
AplicacionCarteraSchema.index({ sourceType: 1, sourceId: 1 });

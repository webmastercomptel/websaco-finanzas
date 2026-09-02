import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Account } from '../cuentas/account.schema';

export type AplicacionCarteraDocument = HydratedDocument<AplicacionCartera>;

export const SOURCE_TYPES = ['RC', 'NC'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const DOCUMENT_TYPES = ['FV', 'ND'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * One cruce: one row per application of a Recibo OR a Nota Crédito against a
 * document. `sourceType` discriminates which kind of document made the
 * application — the source-of-truth event log both modules share (design
 * §3.1). `Factura.outstandingBalance` and `SaldoCartera.balance` are
 * reconcilable caches derived from these rows.
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
    type: Types.ObjectId,
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
  @Prop({ type: Types.ObjectId, required: true })
  sourceId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES })
  documentType: DocumentType;

  @Prop({ type: Types.ObjectId, required: true })
  documentId: Types.ObjectId;

  @Prop({ required: true })
  amountApplied: number;

  @Prop({ required: true, enum: ['activa', 'revertida'], default: 'activa' })
  status: 'activa' | 'revertida';

  @Prop({ required: true })
  appliedAt: Date;

  /** Set at the same moment `status` flips to 'revertida' — closes the
   *  "was this application active on date X?" gap for historical cartera
   *  queries (Vencimientos §8, Cartera General §2). */
  @Prop({ type: Date, default: null })
  revertedAt: Date | null;

  @Prop({ type: Types.ObjectId, ref: Account.name, required: true })
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

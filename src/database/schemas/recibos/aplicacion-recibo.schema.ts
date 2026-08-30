import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Recibo } from './recibo.schema';
import { Account } from '../cuentas/account.schema';

export type AplicacionReciboDocument = HydratedDocument<AplicacionRecibo>;

export const DOCUMENT_TYPES = ['FV', 'ND'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * One cruce: one row per application of a Recibo against a document. The
 * source-of-truth event log — `Factura.outstandingBalance` and
 * `SaldoCartera.balance` are reconcilable caches derived from these rows,
 * same precedent as `SaldoCartera` relative to `Factura` (see design §3).
 *
 * Only `'FV'` (Factura) is implemented and validated today; `'ND'` is
 * reserved for when Notas Débito exists (design §2, out of scope) — the
 * schema admits it now so that module's arrival never needs a migration.
 *
 * A separate collection rather than an array embedded on Recibo: a cruce can
 * happen long after the receipt is created (applying an anticipo), and the
 * recurring query is "every application against Factura X," which an
 * embedded array only answers via a collection-wide `$unwind`.
 */
@Schema({ timestamps: true, collection: 'aplicaciones_recibo' })
export class AplicacionRecibo {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: Recibo.name, required: true })
  reciboId: Types.ObjectId;

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

  @Prop({ type: Types.ObjectId, ref: Account.name, required: true })
  appliedBy: Types.ObjectId;
}

export const AplicacionReciboSchema =
  SchemaFactory.createForClass(AplicacionRecibo);

// Every application against a given document — the future Auxiliar de
// Cartera screen's query (design §3).
AplicacionReciboSchema.index({ documentType: 1, documentId: 1 });
// Every application a given receipt made — the void-cascade query.
AplicacionReciboSchema.index({ reciboId: 1 });

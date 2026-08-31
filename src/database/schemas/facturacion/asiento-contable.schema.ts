import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { LoteFacturacion } from './lote-facturacion.schema';
import { Factura } from './factura.schema';
import { Recibo } from '../recibos/recibo.schema';
import { NotaCredito } from '../notas-credito/nota-credito.schema';

export type AsientoContableDocument = HydratedDocument<AsientoContable>;

/** One debit or credit line of a journal entry. */
@Schema({ _id: false })
export class Movimiento {
  @Prop({ required: true, trim: true })
  account: string;

  @Prop({ required: true, enum: ['debito', 'credito'] })
  type: 'debito' | 'credito';

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true, trim: true })
  description: string;
}

export const MovimientoSchema = SchemaFactory.createForClass(Movimiento);

/**
 * The double-entry journal entry a consolidated Factura, OR a Recibo
 * application/void, produces.
 *
 * Two anchors, used mutually exclusively depending on origin — same pattern
 * as Asignacion's `scope`/`coPropertyId`/`entidadId` (see that schema):
 *  - A facturación entry sets `loteId` + `facturaId`, `reciboId: null`.
 *  - A Recibo entry sets `reciboId`, `loteId: null`, `facturaId: null` — a
 *    FIFO application can post one entry that touches several Facturas, and
 *    a pure anticipo receipt (nothing applied yet) posts none at all, so
 *    there is no single Factura to anchor it to.
 *
 * A facturación entry sets `loteId`+`facturaId`; a Recibo entry sets
 * `reciboId`; a Nota Crédito entry sets `notaCreditoId` — all four mutually
 * exclusive, all default null.
 *
 * Invariant this schema does not itself enforce (the caller does, before
 * ever calling `.create()`): sum(debito) === sum(credito).
 */
@Schema({ timestamps: true, collection: 'asientos_contables' })
export class AsientoContable {
  @Prop({
    type: Types.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: LoteFacturacion.name, default: null })
  loteId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: Factura.name, default: null })
  facturaId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: Recibo.name, default: null })
  reciboId: Types.ObjectId | null;

  @Prop({ type: Types.ObjectId, ref: NotaCredito.name, default: null })
  notaCreditoId: Types.ObjectId | null;

  @Prop({ required: true })
  date: Date;

  @Prop({ type: [MovimientoSchema], required: true })
  entries: Movimiento[];
}

export const AsientoContableSchema =
  SchemaFactory.createForClass(AsientoContable);

// ⚠️ REQUIRES A ONE-TIME MANUAL MIGRATION BEFORE DEPLOYING THIS BRANCH ⚠️
//
// One AsientoContable per Factura — cheap structural insurance against a
// double-post, given this method runs without a database transaction.
// Partial: a Recibo-driven entry has facturaId: null, and many of those must
// coexist without tripping this uniqueness.
//
// WHAT CHANGED IN THIS BRANCH: this index used to be a plain
// `{ unique: true }` on the same key, with no `partialFilterExpression`. Only
// the OPTIONS changed — the key is identical, so MongoDB still auto-names it
// `facturaId_1`, exactly as the pre-existing strict index is named.
//
// WHY THAT IS A PROBLEM: this repo has no `autoIndex: false` and calls
// `syncIndexes()` nowhere (grep for both — there are zero hits), so Mongoose
// runs its default `createIndexes` on boot. `createIndexes` does NOT update an
// existing index whose name matches but whose options differ: MongoDB rejects
// that with `IndexOptionsConflict` (code 85), Mongoose swallows it into the
// connection's error channel, and THE OLD STRICT UNIQUE INDEX SURVIVES
// UNTOUCHED. Under the old index `null` is a real, duplicate-checkable value,
// and every Recibo-driven entry writes `facturaId: null` — so the SECOND
// Recibo ever created (or applied, or voided) in that environment fails
// forever with a duplicate-key error (E11000).
//
// THE ONE-TIME STEP: before deploying this branch to ANY environment where the
// `asientos_contables` collection already exists (i.e. anywhere Facturación
// has run), drop the old index so Mongoose can create the corrected partial
// one on next boot:
//
//   db.asientos_contables.dropIndex('facturaId_1')
//
// `scripts/migrate-asiento-contable-facturaid-index.js` does exactly this,
// idempotently, and is a no-op against a fresh/empty database.
AsientoContableSchema.index(
  { facturaId: 1 },
  {
    unique: true,
    partialFilterExpression: { facturaId: { $type: 'objectId' } },
  },
);

// Every entry a given Recibo ever produced (its forward applications AND its
// void's reversal) — not unique: a Recibo can post across several calls
// (create, one or more /aplicar, and /anular).
AsientoContableSchema.index({ reciboId: 1 });

// Every entry a given Nota Crédito ever produced (creation, any /aplicar,
// and /anular) — not unique, same reasoning as the reciboId index.
AsientoContableSchema.index({ notaCreditoId: 1 });

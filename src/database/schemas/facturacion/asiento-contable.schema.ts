import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { LoteFacturacion } from './lote-facturacion.schema';
import { Factura } from './factura.schema';
import { Recibo } from '../recibos/recibo.schema';

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

  @Prop({ required: true })
  date: Date;

  @Prop({ type: [MovimientoSchema], required: true })
  entries: Movimiento[];
}

export const AsientoContableSchema =
  SchemaFactory.createForClass(AsientoContable);

// One AsientoContable per Factura — cheap structural insurance against a
// double-post, given this method runs without a database transaction.
// Partial: a Recibo-driven entry has facturaId: null, and many of those must
// coexist without tripping this uniqueness.
AsientoContableSchema.index(
  { facturaId: 1 },
  { unique: true, partialFilterExpression: { facturaId: { $type: 'objectId' } } },
);

// Every entry a given Recibo ever produced (its forward applications AND its
// void's reversal) — not unique: a Recibo can post across several calls
// (create, one or more /aplicar, and /anular).
AsientoContableSchema.index({ reciboId: 1 });

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { DOCUMENT_TYPES } from '../recibos/aplicacion-cartera.schema';
import type { DocumentType } from '../recibos/aplicacion-cartera.schema';

export type SaldoTotalDocumentoDocument = HydratedDocument<SaldoTotalDocumento>;

/**
 * The live, atomically-guarded TOTAL pending balance for one CHARGE document
 * (a Factura or a NotaDebito) — what `Factura`/`NotaDebito.outstandingBalance`
 * used to be, moved off the document itself so it can stay truly immutable
 * (design: "la factura nunca cambia, la que cambia es la cartera").
 *
 * WHY THIS EXISTS AS ITS OWN COLLECTION, SEPARATE FROM `CarteraPorDocumento`:
 * `CarteraPorDocumento` splits a document's balance into one row PER
 * concepto, updated via a `$max(0, …)`-CLAMPING pipeline (never refuses) —
 * fine for a per-concepto breakdown, since the reconcilable, no-single-writer
 * assumption from `SaldoCartera` carries over. But nothing about "does this
 * document have enough balance left, TOTAL, to accept this application" can
 * be answered by summing N separately-updated rows without a race: two
 * concurrent Recibos could each read "enough" from a stale aggregate and
 * both proceed, each successfully decrementing DIFFERENT concepto rows,
 * jointly overdrawing the document with neither write ever conflicting.
 *
 * This collection is the single row `decrementarSaldoFactura`/
 * `decrementarSaldoNotaDebito` atomically compare-and-decrement (the exact
 * `$expr`-guarded `findOneAndUpdate` those functions already used against
 * `Factura`/`NotaDebito` directly, now pointed here instead) — same
 * atomicity guarantee as before, just relocated off the immutable document.
 * `CarteraPorDocumento`'s per-concepto rows remain bookkeeping/detail once
 * this guard has already accepted the application; they no longer need to
 * be the thing standing between the system and an overpayment.
 */
@Schema({ timestamps: true, collection: 'saldos_total_documento' })
export class SaldoTotalDocumento {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES })
  tipoDocumento: DocumentType;

  /** The Factura's or NotaDebito's own `_id`. */
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  documentoId: Types.ObjectId;

  /** Frozen at row creation — `Factura`/`NotaDebito.total`. */
  @Prop({ required: true })
  total: number;

  /** The only field that moves after creation — atomically
   *  compare-and-decremented by `decrementarSaldoFactura`/
   *  `decrementarSaldoNotaDebito`, incremented back on an anulación. */
  @Prop({ required: true })
  saldoPendiente: number;
}

export const SaldoTotalDocumentoSchema =
  SchemaFactory.createForClass(SaldoTotalDocumento);

SaldoTotalDocumentoSchema.index({ documentoId: 1 }, { unique: true });
// GET /notas-debito?inmuebleId=...-shaped "con saldo pendiente" queries —
// same role the old `{ coPropertyId, inmuebleId, outstandingBalance }` index
// on NotaDebito played; those candidate queries now join through here.
SaldoTotalDocumentoSchema.index({ coPropertyId: 1, saldoPendiente: 1 });

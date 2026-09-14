import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { ConceptoCobro } from '../conceptos/concepto-cobro.schema';
import { DOCUMENT_TYPES } from '../recibos/aplicacion-cartera.schema';
import type { DocumentType } from '../recibos/aplicacion-cartera.schema';

export type CarteraPorDocumentoDocument = HydratedDocument<CarteraPorDocumento>;

/**
 * The live cartera ledger for one CHARGE document (a Factura or a
 * NotaDebito) broken down by concepto — one row per (documentoId,
 * conceptoId). This is what `saldoPendiente` used to be:
 * `FacturaLinea.remainingAmount` (and `Factura`/`NotaDebito.outstandingBalance`
 * as their sum). Those fields are gone precisely so a Factura/NotaDebito can
 * be truly immutable once issued — everything about what it currently owes
 * lives here instead, mutated only by the transactions that apply money or
 * reclassify a concepto against it (Recibos, Notas Crédito, Notas Anticipo,
 * Notas Contables), never by touching the original document.
 *
 * `montoOriginal`/`saldoAnterior`/`saldoNuevo` are frozen the moment the row
 * is created (at Factura consolidación or NotaDebito emisión) — they replace
 * `FacturaLinea.totalAmount`/`balanceBefore`/`balanceAfter` for the purpose of
 * printing "Saldo Anterior / Nuevo Saldo" per concepto on the original
 * document's PDF. Only `saldoPendiente` moves after creation.
 *
 * A document's own total pending balance (what `Factura.outstandingBalance`
 * used to be) is never stored as its own field — it is always
 * `sum(saldoPendiente) WHERE documentoId = X`, so it can never drift from the
 * per-concepto rows that make it up.
 *
 * Deliberately separate from `SaldoCartera` (which stays exactly as it is,
 * aggregated across every document for one inmueble+concepto): that table is
 * kept on purpose as an independent, redundantly-maintained audit control —
 * Conciliación de Cartera exists to catch the two drifting apart. This table
 * answers a different question ("what does THIS document still owe, per
 * concepto") that `SaldoCartera` structurally cannot, since it has no notion
 * of which document contributed what.
 */
@Schema({ timestamps: true, collection: 'cartera_por_documento' })
export class CarteraPorDocumento {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Inmueble.name,
    required: true,
    index: true,
  })
  inmuebleId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: DOCUMENT_TYPES })
  tipoDocumento: DocumentType;

  /** The Factura's or NotaDebito's own `_id` — which collection to look in is
   *  determined by `tipoDocumento`, same convention as
   *  `AplicacionCartera.documentId`. */
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  documentoId: Types.ObjectId;

  @Prop({
    type: SchemaTypes.ObjectId,
    ref: ConceptoCobro.name,
    required: true,
  })
  conceptoId: Types.ObjectId;

  /** Frozen at row creation — this concepto's original charge on this
   *  document, replaces `FacturaLinea.totalAmount` for this purpose. */
  @Prop({ required: true })
  montoOriginal: number;

  /** The only field that moves after creation. Decremented by Recibo/Nota
   *  Crédito/Nota Anticipo application (and incremented back when one of
   *  those is anulada), moved concepto-to-concepto by Nota Contable. */
  @Prop({ required: true })
  saldoPendiente: number;

  /** Frozen at row creation, replaces `FacturaLinea.balanceBefore` — this
   *  concepto's `SaldoCartera` balance for the inmueble immediately before
   *  this document's charge was added. */
  @Prop({ required: true })
  saldoAnterior: number;

  /** Frozen at row creation, replaces `FacturaLinea.balanceAfter`.
   *  `saldoNuevo - saldoAnterior` always equals `montoOriginal`. */
  @Prop({ required: true })
  saldoNuevo: number;
}

export const CarteraPorDocumentoSchema =
  SchemaFactory.createForClass(CarteraPorDocumento);

// One row per document+concepto — the write-side invariant every
// `ajustarSaldosCartera*` call relies on (`findOneAndUpdate` targets exactly
// one row, never an upsert that could silently duplicate it).
CarteraPorDocumentoSchema.index(
  { documentoId: 1, conceptoId: 1 },
  { unique: true },
);
// The aggregate-by-inmueble read path (Cartera por Inmueble, Cartera
// General) — same shape `SaldoCartera`'s own index serves.
CarteraPorDocumentoSchema.index({
  coPropertyId: 1,
  inmuebleId: 1,
  conceptoId: 1,
});

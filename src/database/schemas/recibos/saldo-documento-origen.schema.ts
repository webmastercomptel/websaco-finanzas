import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';

export const ORIGEN_TYPES = ['RC', 'NC', 'SI'] as const;
export type OrigenType = (typeof ORIGEN_TYPES)[number];

export type SaldoDocumentoOrigenDocument =
  HydratedDocument<SaldoDocumentoOrigen>;

/**
 * The live "how much of this SOURCE document is still unapplied" ledger —
 * one row per Recibo, Nota Crédito, or Saldo Inicial de Anticipo (`'SI'` —
 * an opening credit balance imported from a client's previous system, see
 * `SaldoInicialAnticipo`'s own schema docblock), replacing their own
 * `appliedAmount`/`unappliedAmount` fields so those documents can be truly
 * immutable once issued, same reasoning as `CarteraPorDocumento` on the
 * charge side.
 *
 * Unlike `CarteraPorDocumento`, there is no per-concepto breakdown here: a
 * Recibo/Nota Crédito is a single pool of money/credit being drawn down as a
 * whole — WHICH concepto each peso eventually lands on is already recorded,
 * per application, in `AplicacionCartera.detalleConceptos`. Splitting this
 * table by concepto too would just duplicate that with no reader that needs
 * it split at the source.
 *
 * `NotaAnticipo` deliberately has no row here: its own `appliedAmount` is set
 * once at creation and never incremented again by a later application (there
 * is no "apply more to this same anticipo" endpoint) — it is already exactly
 * as immutable as `NotaContable.monto`, so it needs no external ledger.
 *
 * `appliedAmount` is never stored — always `montoOriginal - saldoDisponible`.
 */
@Schema({ timestamps: true, collection: 'saldos_documento_origen' })
export class SaldoDocumentoOrigen {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  coPropertyId: Types.ObjectId;

  @Prop({ type: String, required: true, enum: ORIGEN_TYPES })
  tipoDocumento: OrigenType;

  /** The Recibo's, NotaCredito's, or SaldoInicialAnticipo's own `_id` — which
   *  collection to look in is determined by `tipoDocumento`. */
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  documentoId: Types.ObjectId;

  /** Frozen at row creation — `Recibo.montoRecibido`/`NotaCredito.montoTotal`. */
  @Prop({ required: true })
  montoOriginal: number;

  /** The only field that moves after creation — decremented by each
   *  application against a Factura/NotaDebito, incremented back when one is
   *  anulada, zeroed when the source document itself is anulado. */
  @Prop({ required: true })
  saldoDisponible: number;
}

export const SaldoDocumentoOrigenSchema =
  SchemaFactory.createForClass(SaldoDocumentoOrigen);

SaldoDocumentoOrigenSchema.index({ documentoId: 1 }, { unique: true });

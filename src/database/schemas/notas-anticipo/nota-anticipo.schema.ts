import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Inmueble } from '../copropiedades/inmueble.schema';
import { Tercero } from '../terceros/tercero.schema';
import { Account } from '../cuentas/account.schema';

export type NotaAnticipoDocument = HydratedDocument<NotaAnticipo>;

export const VOID_REASONS_NOTA_ANTICIPO = [
  'error_digitacion',
  'ajuste_contrato',
  'otro',
] as const;
export type VoidReasonNotaAnticipo =
  (typeof VOID_REASONS_NOTA_ANTICIPO)[number];

/**
 * A "Nota de Anticipo" ("NA") — the document that applies a leftover
 * unapplied balance against open cartera LATER, as its own auditable event,
 * instead of a second call mutating the source document directly
 * (`RecibosService` deliberately has no `/aplicar` route — see its
 * controller docblock). One origin document can have many Notas de Anticipo
 * over time, each drawing down a bit more of its leftover balance, exactly
 * like a Recibo itself can be applied against several Facturas.
 *
 * `inmuebleId`/`terceroId` are copied from the origin document at creation —
 * same reasoning as `NotaDebito.terceroId`: frozen at the moment that
 * matters, never re-derived later.
 *
 * `appliedAmount` is the total this ONE document applied — the single
 * `cuentaAnticipos` debit line the accounting entry posts (see
 * `construirMovimientosAplicacionAnticipo`'s own docblock on why the debit
 * side is always one line even when the credit side is split cargo por
 * cargo). The actual per-document/per-concepto breakdown lives in
 * `AplicacionCartera` rows with `sourceType: 'NA'`, `sourceId` this
 * document's own `_id` — same pattern Recibo/NotaCredito already use.
 */
@Schema({ timestamps: true, collection: 'notas_anticipo' })
export class NotaAnticipo {
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

  @Prop({ type: SchemaTypes.ObjectId, ref: Tercero.name, default: null })
  terceroId: Types.ObjectId | null;

  /** Which collection `reciboOrigenId` points into — `'RC'` (a real Recibo,
   *  the only value that existed before this field) or `'SI'` (a
   *  `SaldoInicialAnticipo`, an opening anticipo balance imported from a
   *  client's previous system). Defaults to `'RC'` so every Nota de Anticipo
   *  created before this field existed keeps resolving exactly as it always
   *  did. Kept as a companion field rather than renaming `reciboOrigenId`
   *  itself — the ID field's own name predates this generalization, and
   *  renaming it would be a breaking API-contract change for no behavioral
   *  gain (see root CLAUDE.md's note on shape changes touching both
   *  projects). */
  @Prop({ type: String, enum: ['RC', 'SI'], default: 'RC' })
  origenTipo: 'RC' | 'SI';

  /** The origin document's own `_id` — a `Recibo` when `origenTipo` is
   *  `'RC'`, a `SaldoInicialAnticipo` when `'SI'`. Both freeze a
   *  `fullNumber`/`receivedDate` under those exact names, so
   *  `cruce.util.ts`'s `OrigenAplicacion` shape reads either one with no
   *  branching — see that file's own docblock. */
  @Prop({
    type: SchemaTypes.ObjectId,
    required: true,
    index: true,
  })
  reciboOrigenId: Types.ObjectId;

  @Prop({ type: String, trim: true, default: '' })
  prefix: string;

  @Prop({ type: Number, default: 0 })
  number: number;

  @Prop({ required: true, trim: true })
  fullNumber: string;

  @Prop({ required: true })
  issueDate: Date;

  @Prop({ required: true })
  appliedAmount: number;

  @Prop({ required: true, enum: ['activo', 'anulado'], default: 'activo' })
  status: 'activo' | 'anulado';

  @Prop({ type: String, enum: VOID_REASONS_NOTA_ANTICIPO, default: null })
  voidedReason: VoidReasonNotaAnticipo | null;

  @Prop({ type: String, default: null, trim: true })
  voidedDetail: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generatedBy: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, default: null })
  voidedBy: Types.ObjectId | null;
}

export const NotaAnticipoSchema = SchemaFactory.createForClass(NotaAnticipo);

// A resolution's numbers are unique within a coproperty by construction
// (NumeracionService's atomic reservation), same reasoning as
// Recibo/NotaDebito/Factura.
NotaAnticipoSchema.index({ coPropertyId: 1, fullNumber: 1 }, { unique: true });

// GET /notas-anticipo?reciboOrigenId=...-shaped query, and the Anticipos
// screen's "does this Recibo already have Notas de Anticipo" lookup.
NotaAnticipoSchema.index({ coPropertyId: 1, reciboOrigenId: 1 });

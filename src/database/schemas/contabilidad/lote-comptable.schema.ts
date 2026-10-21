import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { Account } from '../cuentas/account.schema';

export type LoteComptableDocument = HydratedDocument<LoteComptable> & {
  createdAt: Date;
  updatedAt: Date;
};

/** Lifecycle of a lote sent to Comptable. */
export const ESTADOS_LOTE_COMPTABLE = [
  'pendiente',
  'enviado',
  'fallido',
  'retirado',
] as const;
export type EstadoLoteComptable = (typeof ESTADOS_LOTE_COMPTABLE)[number];

/**
 * One push of asientos to Comptable ("Interfaz a Comptable") — the Comptable
 * channel's counterpart of `LoteContabilidad` (the CSV export), with its own
 * numbering and its own stamp on `AsientoContable` (`comptableLoteId`): the
 * two channels never affect each other.
 *
 * Its `_id` is the `loteOrigenId` sent to Comptable, Comptable's idempotency
 * key: a retry of the same lote re-sends the same `_id` and the same
 * `asientoIds`, so Comptable can answer "already received" instead of
 * duplicating it.
 *
 * - `pendiente`: created, sent or about to be, outcome not known yet (a
 *   timeout or network error leaves it here). Only "Reintentar" applies. At
 *   most ONE per coproperty (partial unique index below), which is what makes
 *   two simultaneous "Enviar" produce one lote.
 * - `enviado`: Comptable answered 201 (or "already received"); the asientos
 *   carry `comptableLoteId`.
 * - `fallido`: Comptable rejected it (400/401…); nothing was stamped, the
 *   next "Enviar" opens a new lote.
 * - `retirado`: withdrawn in Comptable (hard delete there) and released here;
 *   kept as history, never deleted.
 *
 * Only the summary is stored, never the payload or Comptable's full response.
 * Spanish persistence per the contract law in CLAUDE.md (newer than the
 * English `LoteContabilidad`).
 */
@Schema({ timestamps: true, collection: 'lotes_comptable' })
export class LoteComptable {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
    index: true,
  })
  copropiedadId: Types.ObjectId;

  /** Own consecutive per coproperty (`ConsecutivoLoteComptable`). */
  @Prop({ required: true })
  numero: number;

  /** Bounds of the billing period the selection was made on, frozen. */
  @Prop({ required: true })
  periodoDesde: Date;

  @Prop({ required: true })
  periodoHasta: Date;

  /** Exactly which entries this lote carries — a retry re-sends these, never
   *  a fresh selection. */
  @Prop({ type: [SchemaTypes.ObjectId], required: true })
  asientoIds: Types.ObjectId[];

  @Prop({ required: true })
  totalAsientos: number;

  @Prop({ required: true })
  totalLineas: number;

  /** In pesos, as the payload sums them (two decimals). */
  @Prop({ required: true })
  totalDebitos: number;

  @Prop({ required: true })
  totalCreditos: number;

  @Prop({
    type: String,
    enum: ESTADOS_LOTE_COMPTABLE,
    required: true,
    default: 'pendiente',
  })
  estado: EstadoLoteComptable;

  /** Why it ended `fallido` (Comptable's message, or the signature hint). */
  @Prop({ type: String, default: null })
  motivoFallo: string | null;

  /** Comptable's own lote id, from its 201 or its "already received" 409. */
  @Prop({ type: String, default: null })
  comptableLoteId: string | null;

  /** Comptable's message when it refused a retiro because the accountant
   *  edited the lote there (`LOTE_INTERVENIDO`); from then on the lote can no
   *  longer be withdrawn from Finanzas. Stays `enviado`. */
  @Prop({ type: String, default: null })
  intervenidoMensaje: string | null;

  @Prop({ type: Date, default: null })
  intervenidoEn: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, required: true })
  generadoPor: Types.ObjectId;

  /** Denormalized: sent to Comptable as `origen.generadoPor.nombre`. */
  @Prop({ required: true, trim: true })
  generadoPorNombre: string;

  /** Who and when the lote became `enviado` (the first attempt's author and
   *  a later "Reintentar" may differ). */
  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, default: null })
  enviadoPor: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  enviadoPorNombre: string | null;

  @Prop({ type: Date, default: null })
  enviadoEn: Date | null;

  @Prop({ type: SchemaTypes.ObjectId, ref: Account.name, default: null })
  retiradoPor: Types.ObjectId | null;

  @Prop({ type: String, default: null })
  retiradoPorNombre: string | null;

  @Prop({ type: Date, default: null })
  retiradoEn: Date | null;
}

export const LoteComptableSchema = SchemaFactory.createForClass(LoteComptable);

LoteComptableSchema.index({ copropiedadId: 1, numero: 1 }, { unique: true });

/**
 * At most one `pendiente` lote per coproperty: the second of two concurrent
 * "Enviar" loses here (E11000 → 409) instead of opening a second lote over
 * the same entries. New collection, so boot-time creation cannot meet
 * duplicates.
 */
LoteComptableSchema.index(
  { copropiedadId: 1 },
  {
    unique: true,
    partialFilterExpression: { estado: 'pendiente' },
    name: 'copropiedadId_pendiente_unico',
  },
);

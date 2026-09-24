// src/database/schemas/publicaciones/publicacion-lote.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';
import { Copropiedad } from '../copropiedades/copropiedad.schema';
import { LoteFacturacion } from '../facturacion/lote-facturacion.schema';

export type PublicacionLoteDocument = HydratedDocument<PublicacionLote>;

export const ESTADOS_PUBLICACION_LOTE = [
  'pendiente',
  'enviando',
  'enviado',
  'fallido',
] as const;
export type EstadoPublicacionLote = (typeof ESTADOS_PUBLICACION_LOTE)[number];

/**
 * One outbox row per `LoteFacturacion`, published outbound to WebSaco3. See
 * `PublicacionFacturasService` for the state machine (`encolar` → `reclamar`
 * → `procesar` → `liberar`) and `design.md`'s "State Machine" section for the
 * full transition diagram.
 *
 * `taxId`/`invoiceNumbers`/`objectPath` are snapshotted at enqueue time and
 * never re-read on retry — only the signed read URL is fresh on every
 * attempt (`presentacion_documento`'s FV row is write-once, so `objectPath`
 * cannot drift underneath a pending retry).
 */
@Schema({ timestamps: true, collection: 'publicaciones_lote' })
export class PublicacionLote {
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: Copropiedad.name,
    required: true,
  })
  coPropertyId: Types.ObjectId;

  /** Unique per batch — see the `unico_publicacion_por_lote` index below,
   *  which is what makes `encolar`'s upsert idempotent. */
  @Prop({
    type: SchemaTypes.ObjectId,
    ref: LoteFacturacion.name,
    required: true,
  })
  loteId: Types.ObjectId;

  /** Snapshot of `Copropiedad.taxId` at enqueue time — WITHOUT the
   *  verification digit, same convention as the schema it is copied from. */
  @Prop({ type: String, required: true, trim: true })
  taxId: string;

  /** Snapshot of `numerosFactura` from the triggering event, in PDF page
   *  order — see `LoteFacturasPdfConfirmadoEvent.numerosFactura`. */
  @Prop({ type: [String], required: true })
  invoiceNumbers: string[];

  /** Snapshot of the lote's combined-PDF storage path. */
  @Prop({ type: String, required: true })
  objectPath: string;

  @Prop({
    type: String,
    required: true,
    enum: ESTADOS_PUBLICACION_LOTE,
    default: 'pendiente',
  })
  status: EstadoPublicacionLote;

  /** Whether this row remains eligible for a future retry. `false` marks a
   *  TERMINAL `fallido` — either a non-retriable response code (401/403) or
   *  a retriable one that exhausted `WEBSACO3_PUBLICACION_MAX_INTENTOS`. */
  @Prop({ type: Boolean, required: true, default: true })
  retryable: boolean;

  /** Incremented AT CLAIM TIME (`reclamar`), not after a send completes — so
   *  a crash loop that never reaches `liberar` still counts toward the max
   *  and eventually reaches terminal `fallido` instead of retrying forever. */
  @Prop({ type: Number, required: true, default: 0 })
  attempts: number;

  /** When this row next becomes claimable. `null` once the row is final
   *  (`enviado`, or terminal `fallido`). */
  @Prop({ type: Date, default: null })
  nextAttemptAt: Date | null;

  /** Set by `reclamar` when this row is claimed by an in-flight attempt;
   *  cleared by `liberar`. A stale `enviando` row (older than
   *  `CLAIM_TTL_MS`) is re-claimable — see the state machine's crash-recovery
   *  branch. */
  @Prop({ type: Date, default: null })
  claimedAt: Date | null;

  /** Per-claim token, checked by `liberar`'s conditional update so a stale
   *  re-claim can never have its outcome overwritten by the claim it
   *  superseded. */
  @Prop({ type: String, default: null })
  claimToken: string | null;

  @Prop({ type: Number, default: null })
  lastStatusCode: number | null;

  /** A SHORT CODE only (e.g. `"HTTP 422"`, `"timeout"`, `"url-firmada"`) —
   *  NEVER a URL or a response body. `urlSigned` must never reach this field
   *  or any log line. */
  @Prop({ type: String, default: null })
  lastError: string | null;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;
}

export const PublicacionLoteSchema =
  SchemaFactory.createForClass(PublicacionLote);

PublicacionLoteSchema.index(
  { loteId: 1 },
  { unique: true, name: 'unico_publicacion_por_lote' },
);
PublicacionLoteSchema.index(
  { status: 1, retryable: 1, nextAttemptAt: 1 },
  { name: 'escaneo_reintentos' },
);
PublicacionLoteSchema.index(
  { status: 1, claimedAt: 1 },
  { name: 'reclamos_vencidos' },
);

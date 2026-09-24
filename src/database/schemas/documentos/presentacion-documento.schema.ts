import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes, Types } from 'mongoose';

export type PresentacionDocumentoDocument =
  HydratedDocument<PresentacionDocumento>;

export const TIPOS_DOCUMENTO_PRESENTACION = [
  'FV',
  'RC',
  'NC',
  'ND',
  'NA',
  'NT',
] as const;
export type TipoDocumentoPresentacion =
  (typeof TIPOS_DOCUMENTO_PRESENTACION)[number];

/**
 * The write-once pointer to ONE emitted document's frozen PDF, of any of the
 * six types this system prints (`FV` Factura, `RC` Recibo, `NC` Nota
 * Crédito, `ND` Nota Débito, `NA` Nota Anticipo, `NT` Nota Contable).
 *
 * SECOND generation of this table. The first rendered PDFs server-side
 * (`@react-pdf/renderer`) and froze a serialized element tree here
 * (`documentDefinition`) at the moment of emission. Rendering moved to the
 * frontend (pdfmake), so there is no tree to freeze any more — what this
 * table freezes now is `objectPath`, a pointer into Cloud Storage
 * (`common/storage/`) at the ALREADY-rendered, already-uploaded PDF file
 * itself. The concept this table exists for is unchanged: "one row per
 * emitted document, immutable forever, opaque to business logic" — only
 * WHAT gets frozen changed, from a tree to a file.
 *
 * A FROZEN FILE, not a frozen tree, is what makes a two-phase write
 * necessary where the old single `guardar()` upsert was enough: rendering a
 * tree was one atomic, in-process step, but uploading a file is a separate
 * round trip the frontend makes AFTER this backend hands out a signed URL —
 * a step that can fail, retry, or never happen at all. So this table now
 * models that as an explicit state machine instead of a single write:
 *
 *  1. `solicitarGeneracion` computes `objectPath` and sets it, WITHOUT
 *     setting `generatedAt` — "a generation was requested", not "a document
 *     exists". Safe to repeat while unconfirmed (an upload that failed can
 *     be retried against a fresh signed URL for the same path).
 *  2. `confirmarGeneracion` verifies the object actually landed in the
 *     bucket (never trusting the frontend's bare claim that it did) and
 *     ONLY THEN sets `generatedAt` — the real immutability boundary. Once
 *     set, this row is frozen: `confirmarGeneracion` REJECTS being called
 *     again for the same key, `solicitarGeneracion` REJECTS restarting a
 *     confirmed row. Nothing this table can be asked to do overwrites a
 *     confirmed document's pointer, unlike the old single-upsert `guardar`,
 *     which happily replaced the previous frozen tree on every rerun (a Nota
 *     Crédito's `aplicar()` re-running, most notably) — a frozen FILE has no
 *     equivalent "re-render and replace" story, because nothing consumes it
 *     ever needs a fresher render: the file that was actually handed to the
 *     recipient is the one that must keep resolving forever.
 *
 * `buscar`/`buscarVarios` read `generatedAt`, never `objectPath` alone, to
 * decide whether "something is generated" — a row that only has `objectPath`
 * (requested, never confirmed) must read identically to "nothing generated
 * yet", the same way an abandoned upload attempt should not make a
 * `GET .../url-lectura` try to serve a file that was never actually
 * finished.
 *
 * Same polymorphic-table conventions as before (kept unchanged from the
 * first generation): `tipoDocumento` names which collection `documentoId`
 * points into (`CarteraPorDocumento`/`SaldoTotalDocumento`/
 * `AplicacionCartera` share this convention), `documentoId` is a plain
 * `ObjectId` with no Mongoose `ref` since the target collection is only
 * known at read time, and this stays a shared table across all six document
 * kinds rather than six near-identical schemas.
 */
@Schema({ collection: 'presentacion_documento', timestamps: false })
export class PresentacionDocumento {
  @Prop({ type: String, required: true, enum: TIPOS_DOCUMENTO_PRESENTACION })
  tipoDocumento: TipoDocumentoPresentacion;

  /** The document's own `_id` — which collection to look in is determined
   *  by `tipoDocumento`, same convention as `CarteraPorDocumento.documentoId`
   *  and `AplicacionCartera.documentId`. */
  @Prop({ type: SchemaTypes.ObjectId, required: true })
  documentoId: Types.ObjectId;

  /** Set by `solicitarGeneracion`, computed server-side from
   *  `(coPropertyId, tipoDocumento, documentoId)` — never accepted from a
   *  caller, same tenancy-law reasoning as `TenantContextService`: a
   *  client-supplied storage path for something that becomes a permanent
   *  record must never be trusted. `null` only ever appears transiently on
   *  a row nothing has requested generation for yet, which in practice means
   *  the row itself does not exist (there is no write path that creates a
   *  row without also setting this). */
  @Prop({ type: String, default: null })
  objectPath: string | null;

  /** `null` until `confirmarGeneracion` verifies the upload actually landed
   *  in the bucket. THIS is the immutability boundary, not row existence —
   *  see the class docblock. */
  @Prop({ type: Date, default: null })
  generatedAt: Date | null;

  /** The `PlantillaDocumento` version that was CURRENT at `solicitarGeneracion`
   *  time — set once, alongside `objectPath`, never touched again. For a
   *  Factura specifically, this is what lets a later live re-render
   *  (`FacturasController.obtenerDocumento`) reproduce the exact layout
   *  that was actually used, instead of whatever the template looks like
   *  today. `null` only for a row written before this field existed. */
  @Prop({ type: Number, default: null })
  plantillaVersion: number | null;
}

export const PresentacionDocumentoSchema = SchemaFactory.createForClass(
  PresentacionDocumento,
);

// One row per document — every write is an upsert against this exact key,
// never an insert-only path that could duplicate it.
PresentacionDocumentoSchema.index(
  { tipoDocumento: 1, documentoId: 1 },
  { unique: true },
);

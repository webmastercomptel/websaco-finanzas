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
 * The frozen react-pdf presentation tree for ONE emitted document, of any of
 * the six types this system prints (`FV` Factura, `RC` Recibo, `NC` Nota
 * Crédito, `ND` Nota Débito, `NA` Nota Anticipo, `NT` Nota Contable) — a
 * serialized element tree (see `serializarArbol`,
 * `common/pdf/react/serializar-arbol.ts`), built once at each document's own
 * moment of emission and rendered client-side from then on, instead of the
 * server re-drawing a PDF on every download.
 *
 * NOT a cache in the regenerable sense — there is no live computation this
 * row is a faster stand-in for. It is a PERMANENT, IMMUTABLE record of what
 * that document looked like the moment it was issued: if the coproperty's
 * phone number changes tomorrow, recomputing the tree from today's data would
 * NOT reproduce what was actually printed and handed to the recipient back
 * then — same reasoning this codebase already applies to `TitularCongelado`
 * and `Factura.discountAmount` (frozen once, at emission, never recalculated
 * later even though the inputs that produced them can still change). This
 * table exists precisely so that frozen snapshot survives independently of
 * whatever the source document/copropiedad/etc. currently say.
 *
 * A NEW enum, deliberately NOT `SOURCE_TYPES`/`DOCUMENT_TYPES`
 * (`recibos/aplicacion-cartera.schema.ts`): those enumerate a cruce's SOURCE
 * (what paid) and TARGET (what got paid down), which is a different axis
 * from "what kind of document is this row a frozen printout for" — `NT`
 * (Nota Contable) in particular never appears as either a `sourceType` or a
 * `documentType` over there (it reclassifies a charge between conceptos, it
 * never applies money), and `NotaContable`'s OWN `tipoDocumento` field
 * (`notas-contables/nota-contable.schema.ts`) already means something else
 * entirely (which Factura/NotaDebito it reclassifies, not itself). Reusing
 * either existing enum here would silently overload one of those meanings.
 *
 * Polymorphic auxiliary table, same convention as `CarteraPorDocumento`/
 * `SaldoTotalDocumento`/`AplicacionCartera`: `tipoDocumento` names which
 * collection `documentoId` points into, so this table can serve all six
 * document kinds without six near-identical schemas or six near-identical
 * services. `documentoId` is a plain `ObjectId` on purpose — no Mongoose
 * `ref` — since which collection it targets is only known at read time, via
 * `tipoDocumento`.
 *
 * Separate from a `documentDefinition` field on each document's own schema
 * (Factura's first iteration, before this table existed, kept it that way —
 * see the migration in this table's own introducing change) precisely so
 * every document type shares ONE mechanism instead of Factura being the
 * lone exception with its own field: a Recibo, a Nota Crédito, etc. all
 * write/read here the same way. It is also why this lives in its own
 * collection rather than embedded: this is opaque PRESENTATION data, never
 * business/financial fact — it never gates whether a financial transaction
 * succeeds (every write here happens strictly AFTER the document's own
 * transaction commits, best-effort, never rolled back together with it),
 * and keeping it out of the document's own schema keeps that document
 * strictly business data, matching "the contract law"'s Spanish-mapped API
 * contract on one side and this opaque Mixed blob, passed through
 * unchanged, on the other.
 *
 * One row per document — every write is an upsert (`guardar`/`guardarVarios`
 * on `PresentacionDocumentoService`), never a plain insert, since a Nota
 * Crédito's `aplicar()` may re-run against the same document and must
 * overwrite its previous printout with a freshly frozen one, not accumulate
 * a second row.
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

  @Prop({ type: SchemaTypes.Mixed, required: true })
  documentDefinition: Record<string, unknown>;

  @Prop({ type: Date, required: true, default: Date.now })
  generatedAt: Date;
}

export const PresentacionDocumentoSchema = SchemaFactory.createForClass(
  PresentacionDocumento,
);

// One frozen record per document — every write is an upsert against this
// exact key, never an insert-only path that could duplicate it.
PresentacionDocumentoSchema.index(
  { tipoDocumento: 1, documentoId: 1 },
  { unique: true },
);

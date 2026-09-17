import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PresentacionDocumento,
  PresentacionDocumentoDocument,
  TipoDocumentoPresentacion,
} from '../../database/schemas/documentos/presentacion-documento.schema';
import type { NodoSerializado } from '../pdf/react/serializar-arbol';

/**
 * Reads/writes `presentacion_documento` — the frozen react-pdf presentation
 * tree for one emitted document (Factura, Recibo, Nota
 * Crédito/Débito/Anticipo/Contable), keyed by `(tipoDocumento, documentoId)`.
 * See the schema's own docblock for why this is a permanent, immutable
 * record (not a regenerable cache) and why it is a shared table instead of a
 * field on each document.
 *
 * Kept small and generic on purpose — every caller (`LotesFacturacionService`
 * today, five more document-creation services in later work) already knows
 * which `tipoDocumento` it owns and builds its own `serializarArbol` tree;
 * this service only ever upserts/reads that frozen tree, never builds one.
 *
 * Registered on the (global) `CommonModule`, not scoped to `facturacion` —
 * this table is shared across module boundaries by design.
 */
@Injectable()
export class PresentacionDocumentoService {
  constructor(
    @InjectModel(PresentacionDocumento.name)
    private readonly model: Model<PresentacionDocumentoDocument>,
  ) {}

  /** Freezes one document's presentation tree — the only write path, called
   *  AFTER the caller's own financial transaction has already committed
   *  (never from inside it: a failure here must never roll back real
   *  business data). Re-running for the same `(tipoDocumento, documentoId)`
   *  (e.g. a Nota Crédito's `aplicar()` running again) overwrites the
   *  previous frozen tree with a fresh one, rather than accumulating a
   *  second row. */
  async guardar(
    tipoDocumento: TipoDocumentoPresentacion,
    documentoId: Types.ObjectId,
    arbol: NodoSerializado | NodoSerializado[] | null,
  ): Promise<void> {
    await this.model
      .findOneAndUpdate(
        { tipoDocumento, documentoId },
        {
          // Opaque-blob cast: `NodoSerializado`'s union isn't structurally
          // identical to the schema's `Record<string, unknown>` Mixed
          // field, but this table never re-validates the tree's shape.
          $set: {
            documentDefinition: arbol as Record<string, unknown>,
            generatedAt: new Date(),
          },
        },
        { upsert: true },
      )
      .exec();
  }

  /** Batch form of `guardar` — one round-trip (`bulkWrite` of upserts) for
   *  every document a single run produces, instead of one round-trip per
   *  document. See `LotesFacturacionService.consolidar()`, which freezes a
   *  `documentDefinition` for potentially hundreds of Facturas in one call. */
  async guardarVarios(
    tipoDocumento: TipoDocumentoPresentacion,
    entradas: {
      documentoId: Types.ObjectId;
      arbol: NodoSerializado | NodoSerializado[] | null;
    }[],
  ): Promise<void> {
    if (entradas.length === 0) return;
    await this.model.bulkWrite(
      entradas.map(({ documentoId, arbol }) => ({
        updateOne: {
          filter: { tipoDocumento, documentoId },
          update: {
            // Same opaque-blob cast as `guardar`'s `$set` above.
            $set: {
              documentDefinition: arbol as Record<string, unknown>,
              generatedAt: new Date(),
            },
          },
          upsert: true,
        },
      })),
    );
  }

  /** One document's frozen tree, or `null` when nothing was ever frozen for
   *  it (a document predating this table, or whose presentation step
   *  failed — the document itself is still valid either way). */
  async buscar(
    tipoDocumento: TipoDocumentoPresentacion,
    documentoId: Types.ObjectId,
  ): Promise<Record<string, unknown> | null> {
    const fila = await this.model
      .findOne({ tipoDocumento, documentoId })
      .exec();
    return fila?.documentDefinition ?? null;
  }

  /** Batch form of `buscar` — one query (`$in`) for every document a listing
   *  page needs, instead of one query per row. A `documentoId` absent from
   *  the returned map means "nothing frozen for it", the same as `buscar`
   *  returning `null` — callers treat both identically. */
  async buscarVarios(
    tipoDocumento: TipoDocumentoPresentacion,
    documentoIds: Types.ObjectId[],
  ): Promise<Map<string, Record<string, unknown> | null>> {
    const mapa = new Map<string, Record<string, unknown> | null>();
    if (documentoIds.length === 0) return mapa;
    const filas = await this.model
      .find({ tipoDocumento, documentoId: { $in: documentoIds } })
      .exec();
    for (const fila of filas) {
      mapa.set(fila.documentoId.toString(), fila.documentDefinition);
    }
    return mapa;
  }
}

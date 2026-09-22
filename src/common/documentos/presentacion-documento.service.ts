import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PresentacionDocumento,
  PresentacionDocumentoDocument,
  TipoDocumentoPresentacion,
} from '../../database/schemas/documentos/presentacion-documento.schema';
import { DocumentoStorageService } from '../storage/documento-storage.service';

/**
 * Reads/writes `presentacion_documento` — the write-once pointer to one
 * emitted document's frozen PDF (Factura, Recibo, Nota
 * Crédito/Débito/Anticipo/Contable), keyed by `(tipoDocumento,
 * documentoId)`. See the schema's own docblock for the full "frozen file,
 * not frozen tree" reasoning behind the two-phase design below, and for why
 * this is a permanent record rather than a regenerable cache.
 *
 * Registered on the (global) `CommonModule`, not scoped to `facturacion` —
 * this table is shared across module boundaries by design, same as before.
 */
@Injectable()
export class PresentacionDocumentoService {
  constructor(
    @InjectModel(PresentacionDocumento.name)
    private readonly model: Model<PresentacionDocumentoDocument>,
    private readonly storage: DocumentoStorageService,
  ) {}

  /**
   * Phase 1 of 2. Computes the deterministic storage path for this document
   * — never accepted from a caller, same tenancy-law reasoning as
   * `TenantContextService.resolveCoPropertyId()` — upserts it onto the row
   * (WITHOUT touching `generatedAt`), and hands back a signed URL the
   * frontend uploads the rendered PDF to.
   *
   * Idempotent while unconfirmed: calling this again for the same key before
   * `confirmarGeneracion` simply re-upserts the same `objectPath` and issues
   * a fresh signed URL, so a failed or abandoned upload can always be
   * retried. Rejected once the row is already confirmed — see the schema's
   * docblock for why a confirmed pointer can never be restarted.
   */
  async solicitarGeneracion(
    tipoDocumento: TipoDocumentoPresentacion,
    documentoId: Types.ObjectId,
    coPropertyId: Types.ObjectId,
  ): Promise<{ objectPath: string; uploadUrl: string; expiresAt: Date }> {
    const existente = await this.model
      .findOne({ tipoDocumento, documentoId })
      .exec();

    if (existente?.generatedAt) {
      throw new ConflictException(
        `Ya existe un documento generado para ${tipoDocumento} ${documentoId.toString()}`,
      );
    }

    const objectPath = `documentos-generados/${coPropertyId.toString()}/${tipoDocumento}/${documentoId.toString()}.pdf`;

    await this.model
      .findOneAndUpdate(
        { tipoDocumento, documentoId },
        { $set: { objectPath } },
        { upsert: true },
      )
      .exec();

    const { uploadUrl, expiresAt } =
      await this.storage.generarUrlSubida(objectPath);

    return { objectPath, uploadUrl, expiresAt };
  }

  /**
   * Phase 2 of 2. Confirms the upload the signed URL from
   * `solicitarGeneracion` was meant for actually completed, and only then
   * freezes the row for good by setting `generatedAt`.
   *
   * Three checks, each guarding against a different way the frontend's
   * claim could be wrong or stale, none of them trusted blindly:
   *  - the row must exist (nothing was ever requested for this key);
   *  - the caller's `objectPath` must match the one this service itself
   *    computed at request time (never the caller's to choose);
   *  - the object must actually exist in the bucket — a signed URL
   *    "succeeding" client-side is not proof the PUT landed.
   * And the row itself must not already be confirmed — see the schema's
   * docblock for why this, not row existence, is the real immutability
   * boundary.
   */
  async confirmarGeneracion(
    tipoDocumento: TipoDocumentoPresentacion,
    documentoId: Types.ObjectId,
    objectPath: string,
  ): Promise<void> {
    const fila = await this.model
      .findOne({ tipoDocumento, documentoId })
      .exec();

    if (!fila) {
      throw new NotFoundException(
        `No se solicitó la generación de ${tipoDocumento} ${documentoId.toString()}`,
      );
    }
    if (fila.generatedAt) {
      throw new ConflictException(
        `El documento ${tipoDocumento} ${documentoId.toString()} ya fue confirmado`,
      );
    }
    if (fila.objectPath !== objectPath) {
      throw new ConflictException(
        `El objectPath informado no coincide con el solicitado para ${tipoDocumento} ${documentoId.toString()}`,
      );
    }

    const subido = await this.storage.existe(objectPath);
    if (!subido) {
      throw new ConflictException(
        `El archivo ${objectPath} todavía no existe en el bucket`,
      );
    }

    fila.generatedAt = new Date();
    await fila.save();
  }

  /** One document's frozen pointer, or `null` when nothing has been
   *  confirmed for it yet — a row that only has `objectPath` (requested but
   *  never confirmed) reads identically to "nothing generated", same as a
   *  document predating this table or one whose generation never ran. */
  async buscar(
    tipoDocumento: TipoDocumentoPresentacion,
    documentoId: Types.ObjectId,
  ): Promise<{ objectPath: string; generatedAt: Date } | null> {
    const fila = await this.model
      .findOne({ tipoDocumento, documentoId })
      .exec();
    if (!fila?.generatedAt || !fila.objectPath) return null;
    return { objectPath: fila.objectPath, generatedAt: fila.generatedAt };
  }

  /** Batch form of `buscar` — one query (`$in`) for every document a listing
   *  page needs, instead of one query per row. A `documentoId` absent from
   *  the returned map means "nothing confirmed for it", the same as
   *  `buscar` returning `null` — callers treat both identically. */
  async buscarVarios(
    tipoDocumento: TipoDocumentoPresentacion,
    documentoIds: Types.ObjectId[],
  ): Promise<Map<string, { objectPath: string; generatedAt: Date }>> {
    const mapa = new Map<string, { objectPath: string; generatedAt: Date }>();
    if (documentoIds.length === 0) return mapa;

    const filas = await this.model
      .find({ tipoDocumento, documentoId: { $in: documentoIds } })
      .exec();

    for (const fila of filas) {
      if (fila.generatedAt && fila.objectPath) {
        mapa.set(fila.documentoId.toString(), {
          objectPath: fila.objectPath,
          generatedAt: fila.generatedAt,
        });
      }
    }
    return mapa;
  }
}

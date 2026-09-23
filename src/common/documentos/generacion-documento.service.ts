import { Injectable, NotFoundException } from '@nestjs/common';
import type { Types } from 'mongoose';
import { PresentacionDocumentoService } from './presentacion-documento.service';
import { PlantillaDocumentoService } from './plantilla-documento.service';
import { DocumentoStorageService } from '../storage/documento-storage.service';
import { toPlantilla } from '../../modules/plantillas-documento/plantillas-documento.mapper';
import type { TipoDocumentoPresentacion } from '../../database/schemas/documentos/presentacion-documento.schema';
import type { PlantillaDocumento } from '../../contracts';

export interface SolicitudGeneracionDocumento<TDatos> {
  plantilla: PlantillaDocumento;
  datos: TDatos;
  objectPath: string;
  uploadUrl: string;
  expiresAt: string;
}

/**
 * Shared solicitar/confirmar/url-lectura orchestration for every financial
 * document's PDF generation. The three-step dance (fetch the type's template
 * + this document's already-computed `datos` + mint an upload URL; confirm
 * the upload; mint a read URL) is identical across Recibo, Nota Crédito,
 * Nota Débito, Nota Contable and Nota Anticipo, and Factura reuses the same
 * `urlLectura` step — only the `tipoDocumento` code and which service
 * produces `datos` differ. Centralizing it here means a change to the flow
 * (e.g. rejecting confirmation for an anulado document) lands once instead
 * of once per document type.
 *
 * Each document's own controller still owns its routes and `@CheckAbility`
 * guard (CASL can't branch a static decorator on a route param), so this
 * service is called FROM those routes, not registered as one itself.
 */
@Injectable()
export class GeneracionDocumentoService {
  constructor(
    private readonly presentacionDocumento: PresentacionDocumentoService,
    private readonly plantillas: PlantillaDocumentoService,
    private readonly storage: DocumentoStorageService,
  ) {}

  /** Phase 1 — fetch the type's template alongside a fresh upload slot for
   *  this specific document, bundled with the caller's already-computed
   *  `datos` so the response is one round trip for the frontend. */
  async solicitar<TDatos>(
    tipoDocumento: TipoDocumentoPresentacion,
    doc: { _id: Types.ObjectId; coPropertyId: Types.ObjectId },
    datos: TDatos,
  ): Promise<SolicitudGeneracionDocumento<TDatos>> {
    const [plantilla, solicitud] = await Promise.all([
      this.plantillas.findOne(tipoDocumento),
      this.presentacionDocumento.solicitarGeneracion(
        tipoDocumento,
        doc._id,
        doc.coPropertyId,
      ),
    ]);
    return {
      plantilla: toPlantilla(plantilla),
      datos,
      objectPath: solicitud.objectPath,
      uploadUrl: solicitud.uploadUrl,
      expiresAt: solicitud.expiresAt.toISOString(),
    };
  }

  /** Phase 2 — thin passthrough, kept here (not inlined per-controller) so
   *  the response shape stays identical everywhere it's called from. */
  async confirmar(
    tipoDocumento: TipoDocumentoPresentacion,
    doc: { _id: Types.ObjectId },
    objectPath: string,
  ): Promise<{ objectPath: string }> {
    await this.presentacionDocumento.confirmarGeneracion(
      tipoDocumento,
      doc._id,
      objectPath,
    );
    return { objectPath };
  }

  /** A short-lived signed read URL for an already-confirmed document —
   *  `etiquetaEntidad` is the Spanish noun each controller's own 404 message
   *  used before this was centralized (e.g. "La factura", "El recibo"). */
  async urlLectura(
    etiquetaEntidad: string,
    id: string,
    doc: { objectPath: string | null; generatedAt: Date | string | null },
  ): Promise<{ url: string; expiresAt: string }> {
    if (!doc.objectPath || !doc.generatedAt) {
      throw new NotFoundException(
        `${etiquetaEntidad} ${id} todavía no tiene un documento generado`,
      );
    }
    const { url, expiresAt } = await this.storage.generarUrlLectura(
      doc.objectPath,
    );
    return { url, expiresAt: expiresAt.toISOString() };
  }
}

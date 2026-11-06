// src/modules/facturacion/factura-pdf.util.ts
import { NotFoundException } from '@nestjs/common';
import type { PresentacionDocumentoService } from '../../common/documentos/presentacion-documento.service';
import type { DocumentoStorageService } from '../../common/storage/documento-storage.service';
import { extraerPaginaPdf } from '../../common/documentos/extraer-pagina-pdf.util';
import {
  esAnulado,
  estamparAnulado,
} from '../../common/documentos/estampar-anulado.util';
import type { FacturaLean } from './facturas.service';

/**
 * The single-invoice PDF: the invoice's own page cut out of its lote's frozen
 * combined file, stamped "ANULADA" at read time when the invoice was voided
 * after the lote was generated. Shared by the staff route
 * (`GET /facturas/:id/documento-pdf`) and the resident portal so both serve
 * byte-for-byte the same document.
 *
 * Extracted fresh on every call; nothing is persisted. The caller is
 * responsible for deciding WHO may ask — this only builds the bytes.
 */
export async function paginaIndividualDeFactura(
  id: string,
  factura: Pick<
    FacturaLean,
    'printSnapshot' | 'paginaEnLote' | 'loteId' | 'estado'
  >,
  presentacionDocumento: Pick<PresentacionDocumentoService, 'buscar'>,
  storage: Pick<DocumentoStorageService, 'descargarBytes'>,
): Promise<Uint8Array> {
  const sinPagina = () =>
    new NotFoundException(
      `La factura ${id} todavía no tiene una página individual disponible`,
    );

  if (!factura.printSnapshot || factura.paginaEnLote === null) {
    throw sinPagina();
  }

  const presentacionLote = await presentacionDocumento.buscar(
    'FV',
    factura.loteId,
  );
  if (!presentacionLote) throw sinPagina();

  const bytesCombinado = await storage.descargarBytes(
    presentacionLote.objectPath,
  );
  const bytesPagina = await extraerPaginaPdf(
    bytesCombinado,
    factura.paginaEnLote,
  );
  return esAnulado(factura.estado)
    ? await estamparAnulado(Buffer.from(bytesPagina), factura.estado)
    : bytesPagina;
}
